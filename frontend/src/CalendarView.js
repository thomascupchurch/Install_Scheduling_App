import React, { useEffect, useState } from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { getDrivingTimeMinutes } from './drivingTime';

const locales = { 'en-US': require('date-fns/locale/en-US') };
const localizer = dateFnsLocalizer({ format, parse, startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 0 }), getDay, locales });

// Deterministic color per job number / id
function colorForJob(job) {
  const key = String(job.job_number || job.id || 'job');
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = key.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360; // 0-359
  const saturation = 55; // fixed for consistency
  const lightness = 48; // balanced for contrast with white text
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

// Core hours (modifiable if needed)
const CORE_START_HOUR = 8; // 08:00
const CORE_END_HOUR = 16;  // 16:00 (4pm)
const CORE_SPAN = CORE_END_HOUR - CORE_START_HOUR; // 8 hours

// Build one or many day-sliced events for a job within core hours unless override is set.
async function buildEvents(job, homeBase) {
  let startInput = job.date || job.start || job['Promise Date'] || job['Date Setup'];
  if (typeof startInput === 'string' && /\d{4}-\d{2}-\d{2}$/.test(startInput)) startInput += 'T08:00:00';
  let baseStart = new Date(startInput);
  if (isNaN(baseStart.getTime())) baseStart = new Date();

  // Number of installers affects per-installer hours length for visualization
  const nInstallers = (Array.isArray(job.installers) && job.installers.length) ? job.installers.length : 1;
  const totalManHours = Number(job.man_hours) || 0;
  const perInstallerHours = totalManHours / nInstallers || 0;

  // If override: single continuous event starting at (baseStart + drive)
  let driveMinutes = 0;
  if (homeBase && job.address) {
    try { driveMinutes = await getDrivingTimeMinutes(homeBase, job.address); } catch { driveMinutes = 0; }
  }

  if (job.core_hours_override) {
    const start = new Date(baseStart.getTime() + driveMinutes * 60000);
    const end = new Date(start.getTime() + perInstallerHours * 3600000);
    const color = colorForJob(job);
    return [{
      id: `${job.id}-0`,
      title: job.description || job.job_number,
      start,
      end,
      jobLabel: `${job.job_number || ''} ${job.description || ''}`.trim(),
      manHours: totalManHours,
      color,
  partIndex: 1,
  partsTotal: 1,
  partHours: perInstallerHours,
  remainingHours: 0,
      resource: job
    }];
  }

  // Split into multiple days inside core hours window, accounting for travel each day.
  let remaining = perInstallerHours;
  const events = [];
  let dayIndex = 0;
  // Align baseStart to at least core start hour for its day if earlier than core start; if later (user chose later), keep it.
  const day0 = new Date(baseStart);
  if (day0.getHours() < CORE_START_HOUR) {
    day0.setHours(CORE_START_HOUR, 0, 0, 0);
  }
  // Loop while hours remain
  while (remaining > 0 && dayIndex < 100) { // safety cap
    const currentDay = new Date(day0.getTime() + dayIndex * 24 * 3600000);
    const workStart = new Date(currentDay);
    workStart.setHours(CORE_START_HOUR, 0, 0, 0);
    // Add drive time after 08:00 each day (shifts start later, reducing available window)
    const travelShiftMs = driveMinutes * 60000;
    const shiftedStart = new Date(workStart.getTime() + travelShiftMs);

    // If user specified a later time on initial day, honor that if later than shiftedStart
    if (dayIndex === 0 && baseStart.getTime() > shiftedStart.getTime()) {
      // Still add drive time if baseStart represents pre-drive time; assume baseStart already user-intended start-of-work -> keep
      shiftedStart.setTime(baseStart.getTime());
    }

    const dayEnd = new Date(workStart);
    dayEnd.setHours(CORE_END_HOUR, 0, 0, 0);
    const availableHours = (dayEnd.getTime() - shiftedStart.getTime()) / 3600000;

    if (availableHours <= 0) { // No workable window this day (e.g., drive pushes past end)
      dayIndex += 1;
      continue;
    }
    const hoursThisDay = Math.min(remaining, Math.min(availableHours, CORE_SPAN));
    const eventEnd = new Date(shiftedStart.getTime() + hoursThisDay * 3600000);
    events.push({
      id: `${job.id}-${dayIndex}`,
      // temporary title; will finalize with total parts after loop
      title: job.description || job.job_number,
      start: shiftedStart,
      end: eventEnd,
      jobLabel: `${job.job_number || ''} ${job.description || ''}`.trim(),
      manHours: totalManHours,
      color: colorForJob(job),
  partHours: hoursThisDay,
      resource: job
    });
    remaining -= hoursThisDay;
    dayIndex += 1;
  }
  // Finalize titles with part counts if multi-part
  if (events.length > 1) {
    // compute cumulative / remaining
    let accrued = 0;
    events.forEach((ev, idx) => {
      ev.partIndex = idx + 1;
      ev.partsTotal = events.length;
      accrued += ev.partHours;
      const remaining = Math.max(0, totalManHours - accrued);
      ev.remainingHours = Number(remaining.toFixed(2));
      ev.title = `${job.description || job.job_number} (Part ${ev.partIndex}/${events.length})`;
    });
  } else if (events.length === 1) {
    events[0].partIndex = 1;
    events[0].partsTotal = 1;
    events[0].remainingHours = 0;
  }
  return events;
}

export default function CalendarView() {
  const [events, setEvents] = useState([]);
  const [installers, setInstallers] = useState([]);
  const [homeBase, setHomeBase] = useState('');
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ job_number: '', date: '', description: '', man_hours: '', installers: [], core_hours_override: false, address: '' });
  const [jobQuery, setJobQuery] = useState('');
  const [loading, setLoading] = useState({ installers: false, homeBase: false, schedules: false });
  const [error, setError] = useState(null);
  const [overrideDailyLimit, setOverrideDailyLimit] = useState(false);
  const [inlineEdit, setInlineEdit] = useState({ id: null, desc: '', mh: '', loading: false, error: null });

  // Fetch helpers with error handling
  const loadInstallers = async () => {
    setLoading(l => ({ ...l, installers: true }));
    try {
      const r = await fetch('/api/installers');
      if (!r.ok) throw new Error(`Installers ${r.status}`);
      const data = await r.json();
      setInstallers(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(l => ({ ...l, installers: false }));
    }
  };
  const loadHomeBase = async () => {
    setLoading(l => ({ ...l, homeBase: true }));
    try {
      const r = await fetch('/api/settings/home_base');
      if (!r.ok) throw new Error(`Home base ${r.status}`);
      const d = await r.json();
      setHomeBase(d.home_base || '');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(l => ({ ...l, homeBase: false }));
    }
  };
  const loadSchedules = async (hb = homeBase) => {
    setLoading(l => ({ ...l, schedules: true }));
    try {
      const r = await fetch('/api/schedules');
      if (!r.ok) throw new Error(`Schedules ${r.status}`);
      const jobs = await r.json();
      const arrays = await Promise.all(jobs.map(j => buildEvents(j, hb)));
      setEvents(arrays.flat());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(l => ({ ...l, schedules: false }));
    }
  };
  const retryAll = () => { setError(null); loadInstallers(); loadHomeBase(); loadSchedules(); };

  useEffect(() => { loadInstallers(); loadHomeBase(); }, []);
  useEffect(() => { if (homeBase !== undefined) loadSchedules(homeBase); }, [homeBase]);

  function handleSelectEvent(ev) { setSelected(ev.resource); }
  function handleSelectSlot(slot) {
    const d = slot.start instanceof Date ? slot.start : new Date(slot.start);
    setForm(f => ({ ...f, date: d.toISOString().slice(0,16) }));
    setShowForm(true);
  }
  function handleChange(e) {
    const { name, value, multiple, options, type, checked } = e.target;
    if (multiple) {
      const vals = Array.from(options).filter(o => o.selected).map(o => Number(o.value));
      setForm(f => ({ ...f, [name]: vals }));
    } else if (type === 'checkbox') setForm(f => ({ ...f, [name]: checked }));
    else setForm(f => ({ ...f, [name]: value }));
  }

  // --- Per-installer daily limit helpers (8h) ---
  function getDayString(dtLike) {
    if (!dtLike) return '';
    const d = dtLike instanceof Date ? dtLike : new Date(dtLike);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().slice(0,10);
  }
  function getInstallerAssignedHours(installerId, dateStr) {
    if (!dateStr) return 0;
    return events.filter(ev => {
      const evDay = getDayString(ev.start);
      return evDay === dateStr && Array.isArray(ev.resource?.installers) && ev.resource.installers.includes(installerId);
    }).reduce((sum, ev) => sum + (Number(ev.partHours) || 0), 0);
  }
  function wouldExceedLimit(installerIds, dateStr, totalManHours) {
    if (!dateStr || !totalManHours || !installerIds.length) return false;
    const perInstallerAdd = Number(totalManHours) / installerIds.length;
    return installerIds.some(id => getInstallerAssignedHours(id, dateStr.slice(0,10)) + perInstallerAdd > 8.0001);
  }
  const exceed = wouldExceedLimit(form.installers, form.date, form.man_hours);
  async function submit(e) {
    e.preventDefault();
    try {
      const payload = { ...form, title: form.description || form.job_number, override: overrideDailyLimit };
      const res = await fetch('/api/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Create failed (${res.status})`);
      }
    } catch (e) {
      setError(e.message);
      return;
    }
    setShowForm(false);
    setForm({ job_number: '', date: '', description: '', man_hours: '', installers: [], core_hours_override: false, address: '' });
    setOverrideDailyLimit(false);
    loadSchedules();
  }
  function selectJobNumber(jobNo) {
    const found = events.find(e => e.resource && e.resource.job_number === jobNo);
    if (found) { setSelected(found.resource); setEditing(false); }
  }

  // Daily summary (per installer) for each day present in events
  const dailySummary = (() => {
    const map = {};
    events.forEach(ev => {
      const day = ev.start.toISOString().slice(0,10);
      const job = ev.resource;
      if (!Array.isArray(job?.installers) || !ev.partHours) return;
      job.installers.forEach(id => {
        if (!map[day]) map[day] = {};
        map[day][id] = (map[day][id] || 0) + ev.partHours;
      });
    });
    return Object.entries(map).sort((a,b)=>a[0].localeCompare(b[0]))
      .map(([day, instMap]) => ({ day, installers: Object.entries(instMap).map(([id,h]) => ({ id: Number(id), hours: Number(h.toFixed(2)) })) }));
  })();

  function startEdit() {
    if (!selected) return;
    setEditing(true);
    setForm({
      job_number: selected.job_number,
      description: selected.description || selected.title || '',
      date: selected.date || (selected.start_time ? selected.start_time : ''),
      man_hours: selected.man_hours || '',
      installers: selected.installers || [],
      core_hours_override: !!selected.core_hours_override,
      address: selected.address || ''
    });
  }

  async function saveEdit() {
    if (!selected) return;
    try {
      const payload = { description: form.description, man_hours: form.man_hours, date: form.date, address: form.address, installers: form.installers, override: overrideDailyLimit };
      const res = await fetch(`/api/schedules/${selected.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) {
        const body = await res.json().catch(()=>({}));
        throw new Error(body.error || `Update failed (${res.status})`);
      }
      setEditing(false);
      setSelected(null);
      loadSchedules();
    } catch(e){ setError(e.message); }
  }

  async function deleteJob() {
    if (!selected) return;
    if (!window.confirm('Delete this job?')) return;
    try {
      const res = await fetch(`/api/schedules/${selected.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      setSelected(null);
      setEditing(false);
      loadSchedules();
    } catch(e){ setError(e.message); }
  }

  // Inline edit helpers
  function startInlineEdit(job) {
    setInlineEdit({ id: job.id, desc: job.description || '', mh: job.man_hours || '', loading: false, error: null });
  }
  function cancelInlineEdit() { setInlineEdit({ id: null, desc: '', mh: '', loading: false, error: null }); }
  async function saveInlineEdit(job) {
    setInlineEdit(ie => ({ ...ie, loading: true, error: null }));
    // Check limit if man-hours changed and no override
    const newMH = Number(inlineEdit.mh);
    const jobDate = job.date;
    if (!overrideDailyLimit && job.installers && job.installers.length && newMH) {
      const exceedEdit = wouldExceedLimit(job.installers, jobDate, newMH);
      if (exceedEdit) {
        setInlineEdit(ie => ({ ...ie, loading: false, error: 'Per-installer limit >8h (enable override)' }));
        return;
      }
    }
    try {
      const payload = { description: inlineEdit.desc, man_hours: inlineEdit.mh, override: overrideDailyLimit };
      const res = await fetch(`/api/schedules/${job.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) {
        const body = await res.json().catch(()=>({}));
        throw new Error(body.error || `Update failed (${res.status})`);
      }
      cancelInlineEdit();
      loadSchedules();
    } catch(e) {
      setInlineEdit(ie => ({ ...ie, loading: false, error: e.message }));
    }
  }

  return (
    <div style={{ height: 600, position: 'relative' }}>
      {(loading.installers || loading.homeBase || loading.schedules) && (
        <div style={{ position: 'absolute', top: 0, right: 0, padding: '4px 8px', fontSize: 12, background: '#ffc107', color: '#222', borderBottomLeftRadius: 6, zIndex: 10 }}>
          Loading{loading.schedules ? ' schedules' : loading.installers ? ' installers' : ''}...
        </div>
      )}
      {error && (
        <div role="alert" style={{ background: '#ffebee', color: '#b71c1c', padding: '8px 12px', marginBottom: 8, border: '1px solid #f44336', borderRadius: 4 }}>
          <strong>Error:</strong> {error}
          <button onClick={retryAll} style={{ marginLeft: 12 }}>Retry</button>
        </div>
      )}
      <div style={{ marginBottom: 10 }}>
        <label>Search by Job Number:{' '}
          <input list="job-numbers" value={jobQuery} onChange={e => setJobQuery(e.target.value)} placeholder="Job #" style={{ width: 140 }} />
          <datalist id="job-numbers">
            {events.filter(e => e.resource && e.resource.job_number).map(e => (
              <option key={e.resource.job_number} value={e.resource.job_number} />
            ))}
          </datalist>
        </label>
        <button style={{ marginLeft: 8 }} disabled={!jobQuery} onClick={() => selectJobNumber(jobQuery)}>Go</button>
        <button style={{ marginLeft: 8 }} onClick={() => { setShowForm(true); }}>New</button>
      </div>
      <Calendar
        localizer={localizer}
        events={events}
        startAccessor="start"
        endAccessor="end"
        selectable
        popup
        onSelectEvent={handleSelectEvent}
        onSelectSlot={handleSelectSlot}
        style={{ height: 500 }}
        components={{
          event: ({ event }) => {
            const job = event.resource;
            const isEditing = inlineEdit.id === job.id;
            if (isEditing) {
              return (
                <div style={{ fontSize: 11, lineHeight: 1.3 }} onClick={e => e.stopPropagation()}>
                  <input
                    value={inlineEdit.desc}
                    onChange={e=>setInlineEdit(ie=>({...ie, desc:e.target.value}))}
                    placeholder="Desc"
                    style={{ width: '100%', marginBottom: 2, fontSize: 11 }}
                  />
                  <div style={{ display:'flex', gap:4, alignItems:'center' }}>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={inlineEdit.mh}
                      onChange={e=>setInlineEdit(ie=>({...ie, mh:e.target.value}))}
                      title="Man-Hours"
                      style={{ width: 50, fontSize:11 }}
                    />
                    <button type="button" disabled={inlineEdit.loading} onClick={()=>saveInlineEdit(job)} style={{ fontSize:10 }}>Save</button>
                    <button type="button" disabled={inlineEdit.loading} onClick={cancelInlineEdit} style={{ fontSize:10 }}>X</button>
                  </div>
                  {inlineEdit.error && <div style={{ color:'#b71c1c', fontSize:10 }}>{inlineEdit.error}</div>}
                </div>
              );
            }
            const partsInfo = event.partsTotal > 1 ? `Part ${event.partIndex}/${event.partsTotal} | Slice ${event.partHours}h | Remaining ${event.remainingHours}h of ${event.manHours}h` : `${event.manHours}h total`;
            const tooltip = `${event.jobLabel} \n${partsInfo}`;
            return (
              <span title={tooltip} style={{ position:'relative', paddingRight:14, display:'inline-block', maxWidth:'100%' }}>
                {event.jobLabel}
                <button
                  type="button"
                  onClick={(e)=>{ e.stopPropagation(); startInlineEdit(job); }}
                  style={{ position:'absolute', top:1, right:1, border:'none', background:'rgba(255,255,255,0.25)', color:'#fff', cursor:'pointer', fontSize:10, lineHeight:1, padding:'0 2px' }}
                  title="Inline edit"
                >✎</button>
              </span>
            );
          }
        }}
        eventPropGetter={(event) => {
          const style = {
            backgroundColor: event.color || '#3174ad',
            border: '1px solid rgba(0,0,0,0.25)',
            color: '#fff',
            fontSize: 12,
            padding: 2,
            borderRadius: 4,
            opacity: 0.95
          };
            return { style };
        }}
      />
      {/* Daily hours summary sidebar */}
      <div style={{ position: 'absolute', top: 0, right: 0, width: 230, height: '100%', background: '#fafafa', borderLeft: '1px solid #ddd', padding: '8px 10px', overflowY: 'auto', fontSize: 11 }}>
        <h4 style={{ margin: '4px 0 8px', fontSize: 13 }}>Daily Hours</h4>
        {dailySummary.length === 0 && <div style={{ fontStyle: 'italic' }}>No assignments</div>}
        {dailySummary.map(day => (
          <div key={day.day} style={{ marginBottom: 8 }}>
            <div style={{ fontWeight: 600 }}>{day.day}</div>
            {day.installers.sort((a,b)=>a.id-b.id).map(rec => {
              const inst = installers.find(i=>i.id===rec.id);
              const over = rec.hours > 8.0001;
              return (
                <div key={rec.id} style={{ display: 'flex', justifyContent: 'space-between', color: over ? '#b71c1c' : '#222' }}>
                  <span style={{ maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inst?inst.name:`#${rec.id}`}</span>
                  <span>{rec.hours.toFixed(1)}h</span>
                </div>
              );
            })}
          </div>
        ))}
  <div style={{ fontSize: 10, color: '#666' }}>Red &gt; 8h (override).</div>
      </div>
      {(selected || showForm) && (
        <>
          <div onClick={() => { setSelected(null); setShowForm(false); }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000 }} />
          {/* Modal */}
          {selected && !showForm && (
            <div style={{ position: 'fixed', top: '10%', left: '50%', transform: 'translateX(-50%)', width: '80%', maxWidth: 760, background: '#fff', borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.3)', padding: 20, zIndex: 1001, maxHeight: '78%', overflow: 'auto' }}>
              <h3 style={{ marginTop: 0 }}>{selected.job_number} {selected.description}</h3>
              {!editing && (
                <>
                  <pre style={{ maxHeight: 260, overflow: 'auto', background: '#f6f6f6', padding: 12, borderRadius: 4 }}>{JSON.stringify(selected, null, 2)}</pre>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
                    <button onClick={startEdit}>Edit</button>
                    <button onClick={deleteJob} style={{ background: '#b71c1c', color: '#fff' }}>Delete</button>
                    <button onClick={() => { setSelected(null); setEditing(false); }}>Close</button>
                  </div>
                </>
              )}
              {editing && (
                <form onSubmit={e=>{e.preventDefault(); saveEdit();}} style={{ marginTop: 6 }}>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:12 }}>
                    <label style={{ flex:'1 1 200px' }}>Description<br />
                      <input value={form.description} onChange={e=>setForm(f=>({...f, description:e.target.value}))} style={{ width:'100%' }} />
                    </label>
                    <label style={{ flex:'1 1 120px' }}>Man-Hours<br />
                      <input type="number" min="0" step="0.1" value={form.man_hours} onChange={e=>setForm(f=>({...f, man_hours:e.target.value}))} style={{ width:'100%' }} />
                    </label>
                    <label style={{ flex:'1 1 180px' }}>Date/Time<br />
                      <input type="datetime-local" value={form.date} onChange={e=>setForm(f=>({...f, date:e.target.value}))} style={{ width:'100%' }} />
                    </label>
                  </div>
                  <div style={{ marginTop:10 }}>
                    <label>Address<br />
                      <input value={form.address} onChange={e=>setForm(f=>({...f, address:e.target.value}))} style={{ width:'100%' }} />
                    </label>
                  </div>
                  <div style={{ marginTop:10 }}>
                    <label>Installers<br />
                      <select multiple value={form.installers} onChange={e=>{ const opts=[...e.target.options].filter(o=>o.selected).map(o=>Number(o.value)); setForm(f=>({...f, installers:opts})); }} style={{ width:'100%', minHeight:110 }}>
                        {installers.map(i=>{
                          const dayStr = form.date ? form.date.slice(0,10):'';
                          const assigned = getInstallerAssignedHours(i.id, dayStr);
                          const candidateIds = form.installers.includes(i.id) ? form.installers : [...form.installers, i.id];
                          const perInstallerAdd = form.man_hours && candidateIds.length ? Number(form.man_hours)/candidateIds.length : 0;
                          const wouldExceed = assigned + perInstallerAdd > 8.0001;
                          const disabled = !overrideDailyLimit && !form.installers.includes(i.id) && wouldExceed;
                          return <option key={i.id} value={i.id} disabled={disabled}>{i.name} {assigned?`(${assigned.toFixed(1)}h)`:''}{disabled?' (limit)':''}</option>;
                        })}
                      </select>
                    </label>
                  </div>
                  <div style={{ margin:'8px 0 10px' }}>
                    {exceed && !overrideDailyLimit && (
                      <div style={{ background:'#fff3cd', border:'1px solid #ffeeba', color:'#856404', padding:'6px 8px', borderRadius:4, fontSize:12, marginBottom:6 }}>
                        Per-installer hours would exceed 8h. Adjust or override.
                      </div>
                    )}
                    <label style={{ cursor:'pointer' }}>
                      <input type="checkbox" checked={overrideDailyLimit} onChange={e=>setOverrideDailyLimit(e.target.checked)} style={{ marginRight:6 }} /> Override 8h daily limit
                    </label>
                  </div>
                  <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
                    <button type="submit" disabled={exceed && !overrideDailyLimit}>Save</button>
                    <button type="button" onClick={()=>{ setEditing(false); }}>Cancel</button>
                  </div>
                </form>
              )}
            </div>
          )}
          {showForm && (
            <div style={{ position: 'fixed', top: '10%', left: '50%', transform: 'translateX(-50%)', width: '80%', maxWidth: 520, background: '#fff', borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.3)', padding: 20, zIndex: 1001, maxHeight: '80%', overflowY: 'auto' }}>
              <h3 style={{ marginTop: 0 }}>New Job</h3>
              <form onSubmit={submit}>
                <div style={{ marginBottom: 10 }}>
                  <label>Job #<br />
                    <input name="job_number" value={form.job_number} onChange={handleChange} required style={{ width: '100%' }} />
                  </label>
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label>Description<br />
                    <input name="description" value={form.description} onChange={handleChange} style={{ width: '100%' }} />
                  </label>
                </div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                  <label style={{ flex: '1 1 120px' }}>Man-Hours<br />
                    <input name="man_hours" type="number" min="0" step="0.1" value={form.man_hours} onChange={handleChange} style={{ width: '100%' }} />
                  </label>
                  <label style={{ flex: '1 1 180px' }}>Date/Time<br />
                    <input name="date" type="datetime-local" value={form.date} onChange={handleChange} required style={{ width: '100%' }} />
                  </label>
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label>Address<br />
                    <input name="address" value={form.address} onChange={handleChange} style={{ width: '100%' }} />
                  </label>
                </div>
                <div style={{ marginBottom: 10 }}>
                  <label>Installers<br />
                    <select name="installers" multiple value={form.installers} onChange={handleChange} style={{ width: '100%', minHeight: 110 }}>
                      {installers.map(i => {
                        const dayStr = form.date ? form.date.slice(0,10) : '';
                        const assigned = getInstallerAssignedHours(i.id, dayStr);
                        const candidateIds = form.installers.includes(i.id) ? form.installers : [...form.installers, i.id];
                        const perInstallerAdd = form.man_hours && candidateIds.length ? Number(form.man_hours) / candidateIds.length : 0;
                        const wouldExceed = assigned + perInstallerAdd > 8.0001;
                        const disabled = !overrideDailyLimit && !form.installers.includes(i.id) && wouldExceed;
                        return (
                          <option key={i.id} value={i.id} disabled={disabled}>
                            {i.name} {assigned ? `(${assigned.toFixed(1)}h)` : ''}{disabled ? ' (limit)' : ''}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                </div>
                <div style={{ marginBottom: 14 }}>
                  <label style={{ cursor: 'pointer' }}>
                    <input type="checkbox" name="core_hours_override" checked={form.core_hours_override} onChange={handleChange} style={{ marginRight: 6 }} /> Allow work outside core hours
                  </label>
                </div>
                <div style={{ marginBottom: 12 }}>
                  {exceed && !overrideDailyLimit && (
                    <div style={{ background: '#fff3cd', border: '1px solid #ffeeba', color: '#856404', padding: '6px 8px', borderRadius: 4, fontSize: 12, marginBottom: 6 }}>
                      Per-installer hours would exceed 8h. Adjust inputs or override.
                    </div>
                  )}
                  <label style={{ cursor: 'pointer' }}>
                    <input type="checkbox" checked={overrideDailyLimit} onChange={e => setOverrideDailyLimit(e.target.checked)} style={{ marginRight: 6 }} /> Override 8h daily limit
                  </label>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <button type="submit" disabled={exceed && !overrideDailyLimit}>Save</button>
                  <button type="button" style={{ marginLeft: 8 }} onClick={() => setShowForm(false)}>Cancel</button>
                </div>
              </form>
            </div>
          )}
        </>
      )}
    </div>
  );
}
