import React, { useEffect, useState } from 'react';
import { useCoreHours } from './CoreHoursContext';

// Helper to get YYYY-MM-DD string
function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

// Get next N weekdays from today
function getNextWeekdays(n) {
  const days = [];
  let d = new Date();
  while (days.length < n) {
    if (d.getDay() !== 0 && d.getDay() !== 6) {
      days.push(formatDate(d));
    }
    d.setDate(d.getDate() + 1);
  }
  return days;
}

export default function InstallersAvailability() {
  const [installers, setInstallers] = useState([]);
  const [availability, setAvailability] = useState({}); // {date: {installerId: {out: bool, outHours: [hour,...]}}}
  const [holidays, setHolidays] = useState([]); // [date]
  const [saving, setSaving] = useState(false);
  const { coreStart, coreEnd } = useCoreHours();
  const coreStartNum = Number(coreStart.split(':')[0]);
  const coreEndNum = Number(coreEnd.split(':')[0]);
  const coreHours = Array.from({length: coreEndNum-coreStartNum}, (_,i) => coreStartNum+i);
  const days = getNextWeekdays(10);

  useEffect(() => {
    fetch('/api/installers')
      .then(res => res.json())
      .then(data => setInstallers(data));
    // Load holidays from scheduling settings
    fetch('/api/settings/scheduling')
      .then(r=>r.json())
      .then(data => {
        if (Array.isArray(data.holidays)) setHolidays(data.holidays);
        if (data.availability && typeof data.availability === 'object') setAvailability(data.availability);
      });
  }, []);

  // Debounced save holidays
  useEffect(() => {
    const t = setTimeout(() => {
      setSaving(true);
      fetch('/api/settings/scheduling', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ holidays, availability }) })
        .catch(()=>{})
        .finally(()=> setSaving(false));
    }, 600);
    return () => clearTimeout(t);
  }, [holidays, availability]);

  // Toggle out for a whole day
  function toggleOut(date, installerId) {
    setAvailability(avail => {
      const day = { ...(avail[date] || {}) };
      day[installerId] = { ...(day[installerId] || {}), out: !(day[installerId]?.out) };
      return { ...avail, [date]: day };
    });
  }

  // Toggle out for a specific hour
  function toggleOutHour(date, installerId, hour) {
    setAvailability(avail => {
      const day = { ...(avail[date] || {}) };
      const outHours = new Set(day[installerId]?.outHours || []);
      if (outHours.has(hour)) outHours.delete(hour); else outHours.add(hour);
      day[installerId] = { ...(day[installerId] || {}), outHours: Array.from(outHours) };
      return { ...avail, [date]: day };
    });
  }

  // Toggle holiday
  function toggleHoliday(date) {
    setHolidays(h => h.includes(date) ? h.filter(d => d!==date) : [...h, date]);
  }

  return (
    <div>
  <h2>Installers Availability {saving && <span style={{ fontSize:12, color:'#666' }}>Saving…</span>}</h2>
      <table border="1" cellPadding={4} style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Holiday</th>
            {installers.map(inst => <th key={inst.id}>{inst.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {days.map(date => (
            <tr key={date} style={{ background: holidays.includes(date) ? '#ffe0e0' : undefined }}>
              <td>{date}</td>
              <td>
                <button onClick={() => toggleHoliday(date)} style={{ background: holidays.includes(date) ? '#f88' : undefined }}>
                  {holidays.includes(date) ? 'Holiday' : 'Mark Holiday'}
                </button>
              </td>
              {installers.map(inst => {
                const out = availability[date]?.[inst.id]?.out;
                const outHours = availability[date]?.[inst.id]?.outHours || [];
                return (
                  <td key={inst.id} style={{ background: out ? '#f88' : undefined }}>
                    <button onClick={() => toggleOut(date, inst.id)} style={{ background: out ? '#f88' : undefined, color: out ? '#fff' : undefined }}>
                      {out ? 'Out All Day' : 'Present'}
                    </button>
                    <div style={{ marginTop: 4, fontSize: 12 }}>
                      {coreHours.map(h => (
                        <span key={h}>
                          <button
                            style={{
                              width: 28,
                              background: outHours.includes(h) ? '#f88' : '#fff',
                              color: outHours.includes(h) ? '#fff' : undefined,
                              border: '1px solid #888',
                              marginRight: 2
                            }}
                            onClick={() => toggleOutHour(date, inst.id, h)}
                            disabled={out}
                          >
                            {h}:00
                          </button>
                        </span>
                      ))}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 12, marginTop: 8 }}>
        <b>Legend:</b> <span style={{ background: '#f88', padding: '0 4px' }}>Holiday</span>, <span style={{ background: '#ccc', padding: '0 4px' }}>Out All Day</span>, <span style={{ background: '#bbb', padding: '0 4px' }}>Out Hour</span>
      </div>
    </div>
  );
}
