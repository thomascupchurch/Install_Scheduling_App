import React, { useEffect, useState } from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import withDragAndDrop from 'react-big-calendar/lib/addons/dragAndDrop';
import 'react-big-calendar/lib/addons/dragAndDrop/styles.css';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { getDrivingTimeMinutes } from './drivingTime';

const locales = { 'en-US': require('date-fns/locale/en-US') };
const localizer = dateFnsLocalizer({ format, parse, startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 0 }), getDay, locales });
// Helper: format a Date into local YYYY-MM-DDTHH:MM (avoids UTC shift from toISOString)
function formatLocalDateTime(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth()+1).padStart(2,'0');
  const d = String(dt.getDate()).padStart(2,'0');
  const hh = String(dt.getHours()).padStart(2,'0');
  const mm = String(dt.getMinutes()).padStart(2,'0');
  return `${y}-${m}-${d}T${hh}:${mm}`;
}

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

// Core hours defaults (will be updated from backend settings)
let CORE_START_HOUR = 8; // 08:00
let CORE_END_HOUR = 16;  // 16:00 (4pm)
const coreSpan = () => Math.max(0, CORE_END_HOUR - CORE_START_HOUR);

// Build one or many day-sliced events for a job within core hours unless override is set.
// Enhancement: For multi-day (non-override) jobs we now deduct BOTH morning outbound drive time (home -> job)
// and evening return drive time (job -> home) from each day's workable window, effectively:
//   Work window per day: [08:00 + driveOut, 16:00 - driveReturn]
// (Assuming symmetric drive times). If user supplies a later custom start time on day 1, that overrides 08:00+driveOut.
// If total (driveOut + driveReturn) >= core span, that day yields no workable hours and we skip to next day.
async function buildEvents(job, homeBase, settings) {
  let startInput = job.date || job.start || job['Promise Date'] || job['Date Setup'];
    if (typeof startInput === 'string' && /\d{4}-\d{2}-\d{2}$/.test(startInput)) startInput += 'T08:00:00'; 
    const holidays = Array.isArray(schedSettings?.holidays) ? schedSettings.holidays : [];
    const dayStr = d.toISOString().slice(0,10);
    const isWeekend = d.getDay()===0 || d.getDay()===6 || holidays.includes(dayStr);
  let baseStart = new Date(startInput);
  if (isNaN(baseStart.getTime())) baseStart = new Date();

  // Number of installers affects per-installer hours length for visualization
  const nInstallers = (Array.isArray(job.installers) && job.installers.length) ? job.installers.length : 1;
  const totalManHours = Number(job.man_hours) || 0; // aggregate man-hours (sum across installers)
  const clockHoursTotal = nInstallers ? totalManHours / nInstallers : totalManHours; // elapsed wall time

  // If override: single continuous event starting at (baseStart + drive outbound)
  let driveMinutesOut = 0;
  if (homeBase && job.address) {
    try { driveMinutesOut = await getDrivingTimeMinutes(homeBase, job.address); } catch { driveMinutesOut = 0; }
  }
  // Allow asymmetric drive times from settings (if provided & numeric)
  let driveMinutesReturn = driveMinutesOut;
  if (settings) {
    if (settings.drive_out_minutes !== undefined) driveMinutesOut = Number(settings.drive_out_minutes) || 0;
    if (settings.drive_return_minutes !== undefined) driveMinutesReturn = Number(settings.drive_return_minutes) || 0;
  }

  if (job.core_hours_override) {
    const start = new Date(baseStart.getTime() + driveMinutesOut * 60000);
    const end = new Date(start.getTime() + clockHoursTotal * 3600000);
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
  partHours: clockHoursTotal,
  remainingHours: 0,
  clockHoursTotal,
      resource: job
    }];
  }

  // Split into multiple days inside core hours window, accounting for travel each day (both outbound + return).
  let remaining = clockHoursTotal; // remaining clock (elapsed) hours
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
    const dow = currentDay.getDay();
  const dayStrInner = curr.toISOString().slice(0,10);
  const isWeekend = curr.getDay()===0 || curr.getDay()===6 || holidays.includes(dayStrInner);
    const dayAnchor = new Date(currentDay); // baseline 00:00 of that day
    let windowStart = new Date(dayAnchor);
    let windowEnd = new Date(dayAnchor);
    if (isWeekend) {
      // Full day (non-core) window for weekend
      windowStart.setHours(0,0,0,0);
      windowEnd = new Date(windowStart.getTime() + 24*3600000); // next midnight
    } else {
      windowStart.setHours(CORE_START_HOUR, 0, 0, 0);
      windowEnd.setHours(CORE_END_HOUR, 0, 0, 0);
    }

    // Apply outbound & return drive deductions
    const shiftedStart = new Date(windowStart.getTime() + driveMinutesOut * 60000);
    const shiftedEnd = new Date(windowEnd.getTime() - driveMinutesReturn * 60000);

    // If user specified a later start on day 1, respect it (but can't exceed shiftedEnd)
    if (dayIndex === 0 && baseStart.getTime() > shiftedStart.getTime()) {
      shiftedStart.setTime(Math.min(baseStart.getTime(), shiftedEnd.getTime()));
    }

    // If drive times eat entire day, skip
    if (shiftedEnd.getTime() <= shiftedStart.getTime()) {
      dayIndex += 1;
      continue;
    }

  const availableHours = (shiftedEnd.getTime() - shiftedStart.getTime()) / 3600000;

    if (availableHours <= 0) { // No workable window this day (e.g., drive pushes past end)
      dayIndex += 1;
      continue;
    }
  const cap = isWeekend ? availableHours : Math.min(availableHours, coreSpan());
  const hoursThisDay = Math.min(remaining, cap);
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
      travelOutMinutes: driveMinutesOut,
      travelReturnMinutes: driveMinutesReturn,
  clockHoursTotal,
  resource: job,
  nonCore: isWeekend
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
  accrued += ev.partHours; // accrued clock hours
  // Convert accrued clock -> equivalent man-hours consumed = accrued * nInstallers
  const consumedManHours = accrued * nInstallers;
  const remainingMan = Math.max(0, totalManHours - consumedManHours);
  ev.remainingHours = Number(remainingMan.toFixed(2));
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
  const [loading, setLoading] = useState({ installers: false, homeBase: false, schedules: false, settings:false });
  const [error, setError] = useState(null);
  const [overrideDailyLimit, setOverrideDailyLimit] = useState(false);
  const [overrideAvailability, setOverrideAvailability] = useState(false);
  const [inlineEdit, setInlineEdit] = useState({ id: null, desc: '', mh: '', installers: [], loading: false, error: null });
  const [currentView, setCurrentView] = useState('month');
  const [currentDate, setCurrentDate] = useState(new Date());
  const dayMin = React.useMemo(()=>{ const d=new Date(); d.setHours(7,0,0,0); return d;},[]);
  const scrollToSeven = dayMin; // reuse
  const [sidebarState, setSidebarState] = useState(()=>{
    try { return { dragging:false, offsetX:0, offsetY:0, pinned:true, ...JSON.parse(localStorage.getItem('sidebarState')||'{}') }; } catch { return { dragging:false, x:null, y:null, pinned:true, offsetX:0, offsetY:0 }; }
  });
  const [schedSettings, setSchedSettings] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsForm, setSettingsForm] = useState({ core_start_hour:'', core_end_hour:'', drive_out_minutes:'', drive_return_minutes:'' });
  const [toast, setToast] = useState(null); // { message, ts }
  const [movePreview, setMovePreview] = useState(null); // { job, iso, slices }
  const [skipMultiDayConfirm, setSkipMultiDayConfirm] = useState(()=>{
    try { return localStorage.getItem('skipMultiDayConfirm') === 'true'; } catch { return false; }
  });
  useEffect(()=>{ try { localStorage.setItem('skipMultiDayConfirm', String(skipMultiDayConfirm)); } catch {} }, [skipMultiDayConfirm]);
  useEffect(()=>{ if (!toast) return; const t = setTimeout(()=> setToast(null), 6000); return ()=> clearTimeout(t); }, [toast]);

  function startDragSidebar(e){
    e.preventDefault();
    setSidebarState(s=>({ ...s, dragging:true, pinned:false, offsetX: e.clientX - (s.x ?? window.innerWidth - 230), offsetY: e.clientY - (s.y ?? 0), x: s.x ?? window.innerWidth - 230, y: s.y ?? 0 }));
  }
  React.useEffect(()=>{
    function onMove(e){
      setSidebarState(s=> s.dragging ? { ...s, x: e.clientX - s.offsetX, y: Math.max(0, e.clientY - s.offsetY) } : s);
    }
    function onUp(){ setSidebarState(s=> s.dragging ? { ...s, dragging:false } : s); }
    if (sidebarState.dragging){
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }
    return ()=>{
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [sidebarState.dragging]);

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
      const arrays = await Promise.all(jobs.map(j => buildEvents(j, hb, schedSettings)));
      setEvents(arrays.flat());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(l => ({ ...l, schedules: false }));
    }
  };
  const loadSettings = async () => {
    setLoading(l=>({...l, settings:true}));
    try {
      const r = await fetch('/api/settings/scheduling');
      if (!r.ok) throw new Error(`Settings ${r.status}`);
      const data = await r.json();
      setSchedSettings(data);
      if (data.core_start_hour) CORE_START_HOUR = Number(data.core_start_hour)||8;
      if (data.core_end_hour) CORE_END_HOUR = Number(data.core_end_hour)||16;
      setSettingsForm(f=>({
        core_start_hour: data.core_start_hour ?? f.core_start_hour ?? '8',
        core_end_hour: data.core_end_hour ?? f.core_end_hour ?? '16',
        drive_out_minutes: data.drive_out_minutes ?? f.drive_out_minutes ?? '0',
        drive_return_minutes: data.drive_return_minutes ?? f.drive_return_minutes ?? '0'
      }));
    } catch(e){ setError(e.message); } finally { setLoading(l=>({...l, settings:false})); }
  };
  const retryAll = () => { setError(null); loadInstallers(); loadHomeBase(); loadSchedules(); };

  useEffect(() => { loadInstallers(); loadHomeBase(); loadSettings(); }, []);
  useEffect(() => { if (homeBase !== undefined && schedSettings) loadSchedules(homeBase); }, [homeBase, schedSettings]);
  useEffect(()=>{ const { dragging, offsetX, offsetY, ...persist } = sidebarState; localStorage.setItem('sidebarState', JSON.stringify(persist)); }, [sidebarState]);

  function handleSelectEvent(ev) { setSelected(ev.resource); }
  function handleSelectSlot(slot) {
    const d = slot.start instanceof Date ? slot.start : new Date(slot.start);
    setForm(f => ({ ...f, date: d.toISOString().slice(0,16) }));
  // Store as local wall time string (was using UTC toISOString causing hour jumps)
  setForm(f => ({ ...f, date: formatLocalDateTime(d) }));
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
    // Returns already-assigned "per-installer" hours (clock hours *not* total man-hours) for that day
    if (!dateStr) return 0;
    return events.filter(ev => {
      const evDay = getDayString(ev.start);
      return evDay === dateStr && Array.isArray(ev.resource?.installers) && ev.resource.installers.includes(installerId);
    }).reduce((sum, ev) => {
      const installersCnt = (ev.resource?.installers?.length) || 1;
      // Each slice's elapsed hours = ev.partHours. Per installer consumption that day for this slice = ev.partHours (clock)
      // We compare against 8 clock hours per installer, so add ev.partHours directly.
      return sum + (Number(ev.partHours) || 0);
    }, 0);
  }
  function wouldExceedLimit(installerIds, dateStr, totalManHours) {
    if (!dateStr || !totalManHours || !installerIds.length) return false;
    // New job per-installer clock hours = totalManHours / installerCount
    const perInstallerClockAdd = Number(totalManHours) / installerIds.length; // man-hours divided by installers = clock hours per installer
    return installerIds.some(id => getInstallerAssignedHours(id, dateStr.slice(0,10)) + perInstallerClockAdd > 8.0001);
  }
  const exceed = wouldExceedLimit(form.installers, form.date, form.man_hours);
  const isWeekend = (()=>{ if(!form.date) return false; const d=new Date(form.date); const g=d.getDay(); return g===0||g===6; })();
  const weekendBlocked = isWeekend && !form.core_hours_override;
  const holidays = Array.isArray(schedSettings?.holidays) ? schedSettings.holidays : [];
  const availability = schedSettings?.availability || {};
  const dateDayStr = form.date ? form.date.slice(0,10) : '';
  const isHoliday = dateDayStr && holidays.includes(dateDayStr);
  const availabilityBlocked = (() => {
    if (!dateDayStr || !form.installers.length) return false;
    const dayAvail = availability[dateDayStr] || {};
    // If any selected installer marked out all day -> blocked
    return form.installers.some(id => dayAvail[id]?.out === true);
  })();
  function detectOverlap(startISO, manHours, installerIds, excludeJobId){
    if(!startISO || !manHours || !installerIds || !installerIds.length) return false;
    const start = new Date(startISO);
    if(isNaN(start.getTime())) return false;
    const perInstaller = Number(manHours)/(installerIds.length||1);
    const end = new Date(start.getTime() + perInstaller*3600000);
    return events.some(ev=>{
      if (excludeJobId && ev.resource?.id === excludeJobId) return false;
      if(!Array.isArray(ev.resource?.installers)) return false;
      if(!ev.resource.installers.some(id=>installerIds.includes(id))) return false;
      // same day check quick
      if (ev.start.toISOString().slice(0,10)!== start.toISOString().slice(0,10)) return false;
      return ev.start < end && start < ev.end;
    });
  }
  // Availability conflict: use schedSettings.availability { date: { installerId: { out: bool, outHours:[hour] } } }
  function availabilityConflict(startISO, manHours, installerIds) {
    if (!schedSettings || !startISO || !installerIds?.length || !manHours) return false;
    const avail = schedSettings.availability || {};
    const d = new Date(startISO);
    if (isNaN(d.getTime())) return false;
    const dayStr = startISO.slice(0,10);
    const dayAvail = avail[dayStr] || {};
    const perClock = Number(manHours)/(installerIds.length||1); // elapsed hours
    const startHour = d.getHours() + d.getMinutes()/60;
    // Only check hours on first day (multi-day continuation allowed later)
    const endHour = startHour + perClock;
    return installerIds.some(id => {
      const rec = dayAvail[id];
      if (!rec) return false;
      if (rec.out) return true;
      if (Array.isArray(rec.outHours) && rec.outHours.length) {
        const blocked = rec.outHours.some(h => h >= Math.floor(startHour) && h < endHour); // hour integer within range
        if (blocked) return true;
      }
      return false;
    });
  }
  const overlapConflict = detectOverlap(form.date, form.man_hours, form.installers);
  const availabilityPartialConflict = availabilityConflict(form.date, form.man_hours, form.installers);
  async function submit(e) {
    e.preventDefault();
  if (weekendBlocked || (isHoliday && !form.core_hours_override)) { return; }
  if ((availabilityBlocked || availabilityPartialConflict) && !(overrideDailyLimit || overrideAvailability)) { setError('Selected installer is out (availability)'); return; }
  if (overlapConflict && !overrideDailyLimit) { setError('Overlap with existing assignment (enable override)'); return; }
    try {
  const payload = { ...form, title: form.description || form.job_number, override: overrideDailyLimit, override_availability: overrideAvailability };
      const res = await fetch('/api/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Create failed (${res.status})`);
      if (body.shiftedWeekend || body.shiftedHoliday) {
        const kind = body.shiftedWeekend ? 'Weekend' : 'Holiday';
        setToast({ message: `${kind} date auto-shifted to next business day (${body.original_date?.slice(0,10)} → ${body.date?.slice(0,10)})`, ts: Date.now() });
      }
      if (Array.isArray(body.rule_overrides) && body.rule_overrides.length) {
        setToast({ message: `Created with overrides: ${body.rule_overrides.join(', ')}`, ts: Date.now() });
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
  const payload = { description: form.description, man_hours: form.man_hours, date: form.date, address: form.address, installers: form.installers, override: overrideDailyLimit, override_availability: overrideAvailability };
      const res = await fetch(`/api/schedules/${selected.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(body.error || `Update failed (${res.status})`);
      if (body.shiftedWeekend || body.shiftedHoliday) {
        const kind = body.shiftedWeekend ? 'Weekend' : 'Holiday';
        setToast({ message: `${kind} date auto-shifted to next business day (${body.original_date?.slice(0,10)} → ${body.date?.slice(0,10)})`, ts: Date.now() });
      }
      if (Array.isArray(body.rule_overrides) && body.rule_overrides.length) {
        setToast({ message: `Updated with overrides: ${body.rule_overrides.join(', ')}`, ts: Date.now() });
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
    setInlineEdit({ id: job.id, desc: job.description || '', mh: job.man_hours || '', installers: [...(job.installers||[])], loading: false, error: null });
  }
  function cancelInlineEdit() { setInlineEdit({ id: null, desc: '', mh: '', installers: [], loading: false, error: null }); }
  function wouldExceedLimitEditing(job, newInstallerIds, dateStr, newManHours){
    if (!newInstallerIds || !newInstallerIds.length || !newManHours) return false;
    const originalMH = Number(job.man_hours) || 0;
    const originalInstallers = job.installers || [];
    const perNew = newManHours / newInstallerIds.length;
    return newInstallerIds.some(installerId => {
  // Remove original job's per-installer clock hours if this installer had it
  const originalPerInstallerClock = (originalInstallers.includes(installerId) && originalInstallers.length) ? (originalMH / originalInstallers.length) : 0;
  const currentAssigned = getInstallerAssignedHours(installerId, dateStr) - originalPerInstallerClock;
  return currentAssigned + perNew > 8.0001; // compare in clock hours
    });
  }
  async function saveInlineEdit(job) {
    setInlineEdit(ie => ({ ...ie, loading: true, error: null }));
    const newMH = Number(inlineEdit.mh);
    const jobDate = job.date?.slice(0,10) || '';
    const newInstallers = inlineEdit.installers && inlineEdit.installers.length ? inlineEdit.installers : (job.installers||[]);
    if (!overrideDailyLimit && newInstallers.length && newMH) {
      const exceedEdit = wouldExceedLimitEditing(job, newInstallers, jobDate, newMH);
      if (exceedEdit) {
        setInlineEdit(ie => ({ ...ie, loading: false, error: 'Per-installer limit >8h (enable override)' }));
        return;
      }
      // Overlap check
      const potentialISO = job.date || job.start_time || jobDate + 'T08:00';
      if (detectOverlap(potentialISO, newMH, newInstallers, job.id)) {
        setInlineEdit(ie => ({ ...ie, loading:false, error: 'Time overlap (enable override)' }));
        return;
      }
      if (availabilityConflict(potentialISO, newMH, newInstallers)) {
        setInlineEdit(ie => ({ ...ie, loading:false, error: 'Installer out (availability)' }));
        return;
      }
    }
    try {
  const payload = { description: inlineEdit.desc, man_hours: inlineEdit.mh, installers: newInstallers, override: overrideDailyLimit, override_availability: overrideAvailability };
      const res = await fetch(`/api/schedules/${job.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(body.error || `Update failed (${res.status})`);
      if (body.shiftedWeekend || body.shiftedHoliday) {
        const kind = body.shiftedWeekend ? 'Weekend' : 'Holiday';
        setToast({ message: `${kind} date auto-shifted to next business day (${body.original_date?.slice(0,10)} → ${body.date?.slice(0,10)})`, ts: Date.now() });
      }
      if (Array.isArray(body.rule_overrides) && body.rule_overrides.length) {
        setToast({ message: `Inline saved with overrides: ${body.rule_overrides.join(', ')}`, ts: Date.now() });
      }
      cancelInlineEdit();
      loadSchedules();
    } catch(e) {
      setInlineEdit(ie => ({ ...ie, loading: false, error: e.message }));
    }
  }

  const DnDCalendar = withDragAndDrop(Calendar);

  async function moveEvent({ event, start, end }) {
    // event.resource is the job; adjust its base date/time to new start (keep same time of day)
    const job = event.resource;
    if (!job) return;
    const newStartRaw = new Date(start);
    let newStart = new Date(newStartRaw);
    // Snap logic: if dropped before core start -> set to core start; if after/end or insufficient window -> next business day core start
    const perInstallerHours = (Number(job.man_hours)||0) / Math.max(1,(job.installers||[]).length||1);
    const needsNextDay = () => {
      const h = newStart.getHours() + newStart.getMinutes()/60;
      if (h >= CORE_END_HOUR) return true;
      // remaining core window today
      const remainingToday = CORE_END_HOUR - h;
      return remainingToday <= 0;
    };
    // Adjust early
    if (newStart.getHours() < CORE_START_HOUR) {
      newStart.setHours(CORE_START_HOUR,0,0,0);
    } else if (needsNextDay()) {
      // move to next day core start
      newStart.setDate(newStart.getDate()+1);
      newStart.setHours(CORE_START_HOUR,0,0,0);
    }
    // Skip weekends (Sat=6, Sun=0)
    while (newStart.getDay()===0 || newStart.getDay()===6) {
      newStart.setDate(newStart.getDate()+1);
      newStart.setHours(CORE_START_HOUR,0,0,0);
    }
  const iso = formatLocalDateTime(newStart);
    if (newStart.getTime() !== newStartRaw.getTime()) {
      setToast({ message: 'Dragged outside core hours: snapped to next core window.', ts: Date.now() });
    }
    // Inform if spillover will occur (multi-day automatic continuation)
    const remainWindow = CORE_END_HOUR - (newStart.getHours() + newStart.getMinutes()/60);
    if (perInstallerHours > remainWindow && remainWindow > 0) {
      setToast({ message: 'Event exceeds remaining core hours today: continuing next business day automatically.', ts: Date.now() });
    }
    // Overlap pre-check unless overrideDailyLimit is active (reuse override toggle)
    if (!overrideDailyLimit && detectOverlap(iso, job.man_hours, job.installers, job.id)) {
      setToast({ message: 'Move blocked: overlapping assignment (enable override to force).', ts: Date.now() });
      return; // do not persist
    }
    if (!overrideDailyLimit && availabilityConflict(iso, job.man_hours, job.installers)) {
      setToast({ message: 'Move blocked: installer availability (out).', ts: Date.now() });
      return;
    }
    // Simulate slices to preview if multi-day result
    try {
      const simulated = await buildEvents({ ...job, date: iso, core_hours_override: job.core_hours_override }, homeBase, schedSettings);
      const multi = simulated.length > 1;
      if (multi) {
        if (skipMultiDayConfirm) {
          // Directly commit without modal
          const payload = { date: iso, override: overrideDailyLimit, override_availability: overrideAvailability };
          const res = await fetch(`/api/schedules/${job.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          if (!res.ok) {
            const body = await res.json().catch(()=>({}));
            throw new Error(body.error || `Move failed (${res.status})`);
          }
          const moved = await res.json().catch(()=>({}));
          if (Array.isArray(moved.rule_overrides) && moved.rule_overrides.length) {
            setToast({ message: `Moved with overrides: ${moved.rule_overrides.join(', ')}`, ts: Date.now() });
          }
          loadSchedules();
        } else {
          setMovePreview({ job, iso, slices: simulated.map(s=>({ start:s.start, end:s.end, hours: ((s.end - s.start)/3600000).toFixed(2) })) });
          return;
        }
      }
      // Single slice -> proceed immediately
  const payload = { date: iso, override: overrideDailyLimit, override_availability: overrideAvailability };
      const res = await fetch(`/api/schedules/${job.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) {
        const body = await res.json().catch(()=>({}));
        throw new Error(body.error || `Move failed (${res.status})`);
      }
      const movedSingle = await res.json().catch(()=>({}));
      if (Array.isArray(movedSingle.rule_overrides) && movedSingle.rule_overrides.length) {
        setToast({ message: `Moved with overrides: ${movedSingle.rule_overrides.join(', ')}`, ts: Date.now() });
      }
      loadSchedules();
    } catch(e){ setError(e.message); }
  }

  async function resizeEvent({ event, start, end }) {
    // Derive new per-installer hours from duration in hours (clamped >=0)
    const job = event.resource;
    if (!job) return;
    const hours = Math.max(0, (end.getTime() - start.getTime()) / 3600000);
    // Multiply by installer count to get total man_hours (approx). If multi-part originally, this is a direct edit.
    const installerCount = Array.isArray(job.installers) && job.installers.length ? job.installers.length : 1;
    const newTotal = (hours * installerCount).toFixed(2);
  const startISO = formatLocalDateTime(new Date(start));
    if (!overrideDailyLimit && detectOverlap(startISO, newTotal, job.installers, job.id)) {
      setToast({ message: 'Resize blocked: overlapping assignment (enable override to force).', ts: Date.now() });
      return;
    }
    if (!overrideDailyLimit && availabilityConflict(startISO, newTotal, job.installers)) {
      setToast({ message: 'Resize blocked: installer availability (out).', ts: Date.now() });
      return;
    }
    try {
  const payload = { man_hours: newTotal, override: overrideDailyLimit, override_availability: overrideAvailability };
      const res = await fetch(`/api/schedules/${job.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) {
        const body = await res.json().catch(()=>({}));
        throw new Error(body.error || `Resize failed (${res.status})`);
      }
      const resized = await res.json().catch(()=>({}));
      if (Array.isArray(resized.rule_overrides) && resized.rule_overrides.length) {
        setToast({ message: `Resized with overrides: ${resized.rule_overrides.join(', ')}`, ts: Date.now() });
      }
      loadSchedules();
    } catch(e){ setError(e.message); }
  }

  return (
    <div style={{ height: 600, position: 'relative' }}>
      {toast && (
        <div style={{ position:'fixed', top:10, right:10, background:'#1e88e5', color:'#fff', padding:'8px 12px', borderRadius:6, boxShadow:'0 2px 8px rgba(0,0,0,0.3)', zIndex:2000, fontSize:13 }}>
          {toast.message}
          <button onClick={()=>setToast(null)} style={{ marginLeft:8, background:'transparent', border:'none', color:'#fff', cursor:'pointer', fontWeight:600 }}>×</button>
        </div>
      )}
      {movePreview && (
        <>
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.35)', zIndex:2500 }} onClick={()=>setMovePreview(null)} />
          <div style={{ position:'fixed', top:'15%', left:'50%', transform:'translateX(-50%)', width:'90%', maxWidth:520, background:'#fff', borderRadius:8, padding:18, boxShadow:'0 4px 20px rgba(0,0,0,0.35)', zIndex:2501 }}>
            <h3 style={{ marginTop:0, marginBottom:10 }}>Confirm Multi-Day Move</h3>
            <p style={{ margin:'4px 0 12px', fontSize:13 }}>Moving <strong>{movePreview.job.job_number || movePreview.job.description}</strong> will split into {movePreview.slices.length} day slices based on core hours. Review and confirm.</p>
            <div style={{ maxHeight:220, overflowY:'auto', border:'1px solid #ddd', borderRadius:4, padding:8, background:'#fafafa', fontSize:12 }}>
              {movePreview.slices.map((s,i)=>(
                <div key={i} style={{ padding:'4px 0', borderBottom:i<movePreview.slices.length-1?'1px solid #e0e0e0':'none' }}>
                  <strong>Part {i+1}</strong>: {s.start.toLocaleDateString()} {s.start.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} – {s.end.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} ({s.hours}h)
                </div>
              ))}
            </div>
            <div style={{ display:'flex', justifyContent:'flex-end', gap:10, marginTop:16 }}>
              <label style={{ marginRight:'auto', fontSize:12, display:'flex', alignItems:'center', gap:6 }}>
                <input type="checkbox" checked={skipMultiDayConfirm} onChange={e=>setSkipMultiDayConfirm(e.target.checked)} /> Don't ask again
              </label>
              <button onClick={()=>setMovePreview(null)}>Cancel</button>
              <button onClick={async ()=>{
                try {
                  const payload = { date: movePreview.iso, override: overrideDailyLimit, override_availability: overrideAvailability };
                  const res = await fetch(`/api/schedules/${movePreview.job.id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
                  if (!res.ok) {
                    const body = await res.json().catch(()=>({}));
                    throw new Error(body.error || `Move failed (${res.status})`);
                  }
                  const mv = await res.json().catch(()=>({}));
                  if (Array.isArray(mv.rule_overrides) && mv.rule_overrides.length) {
                    setToast({ message: `Moved with overrides: ${mv.rule_overrides.join(', ')}`, ts: Date.now() });
                  }
                  setMovePreview(null);
                  loadSchedules();
                } catch(err){ setError(err.message); }
              }}>Confirm Move</button>
            </div>
          </div>
        </>
      )}
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
  <button style={{ marginLeft: 8 }} onClick={()=> setShowSettings(true)}>Settings</button>
      </div>
  <DnDCalendar
        localizer={localizer}
        events={events}
        startAccessor="start"
        endAccessor="end"
        selectable
        popup
        onSelectEvent={handleSelectEvent}
        onSelectSlot={(slot)=>{
          handleSelectSlot(slot);
          // If user clicks a day cell in month/week, optionally drill down to day view
          if (currentView !== 'day') {
            setCurrentView('day');
            if (slot && slot.start) setCurrentDate(new Date(slot.start));
          }
        }}
        view={currentView}
        date={currentDate}
        onView={(v)=> setCurrentView(v)}
        onNavigate={(date)=> setCurrentDate(date)}
        views={['month','week','day']}
        style={{ height: 500 }}
  draggableAccessor={() => true}
  min={currentView==='day'? dayMin: undefined}
  scrollToTime={currentView==='day'? scrollToSeven: undefined}
        resizable
        onEventDrop={moveEvent}
        onEventResize={resizeEvent}
        components={{
          event: ({ event }) => {
            const job = event.resource;
            const isEditing = inlineEdit.id === job.id;
            if (isEditing) {
              const predictedExceed = !overrideDailyLimit && (() => {
                const mhNum = Number(inlineEdit.mh);
                return wouldExceedLimitEditing(job, inlineEdit.installers, job.date?.slice(0,10), mhNum);
              })();
              const toggleInstaller = (id) => {
                setInlineEdit(ie => {
                  const list = ie.installers || [];
                  return list.includes(id)
                    ? { ...ie, installers: list.filter(x => x !== id) }
                    : { ...ie, installers: [...list, id] };
                });
              };
              return (
                <div style={{ fontSize: 11, lineHeight: 1.3 }} onClick={e => e.stopPropagation()}>
                  <input
                    value={inlineEdit.desc}
                    onChange={e=>setInlineEdit(ie=>({...ie, desc:e.target.value}))}
                    placeholder="Desc"
                    style={{ width: '100%', marginBottom: 2, fontSize: 11 }}
                  />
                  <div style={{ maxHeight: 52, overflowY: 'auto', border:'1px solid #ffffff33', marginBottom: 2, padding:2 }}>
                    {installers.map(inst => (
                      <label key={inst.id} style={{ display:'inline-block', width: '48%', fontSize:9, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                        <input type="checkbox" style={{ marginRight:2 }} checked={(inlineEdit.installers||[]).includes(inst.id)} onChange={()=>toggleInstaller(inst.id)} />{inst.name}
                      </label>
                    ))}
                  </div>
                  <div style={{ display:'flex', gap:4, alignItems:'center', flexWrap:'wrap' }}>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={inlineEdit.mh}
                      onChange={e=>setInlineEdit(ie=>({...ie, mh:e.target.value}))}
                      title="Man-Hours"
                      style={{ width: 46, fontSize:10 }}
                    />
                    <label style={{ fontSize:9, display:'flex', alignItems:'center', gap:2 }} title="Override 8h limit">
                      <input type="checkbox" checked={overrideDailyLimit} onChange={e=>setOverrideDailyLimit(e.target.checked)} />Ovr
                    </label>
                    <label style={{ fontSize:9, display:'flex', alignItems:'center', gap:2 }} title="Override availability">
                      <input type="checkbox" checked={overrideAvailability} onChange={e=>setOverrideAvailability(e.target.checked)} />Avail
                    </label>
                    <button type="button" disabled={inlineEdit.loading} onClick={()=>saveInlineEdit(job)} style={{ fontSize:9 }}>Save</button>
                    <button type="button" disabled={inlineEdit.loading} onClick={cancelInlineEdit} style={{ fontSize:9 }}>X</button>
                  </div>
                  {predictedExceed && <div style={{ color:'#ffeb3b', fontSize:9 }}>Would exceed 8h</div>}
                  {inlineEdit.error && <div style={{ color:'#b71c1c', fontSize:9 }}>{inlineEdit.error}</div>}
                </div>
              );
            }
            const partsInfo = event.partsTotal > 1
              ? `Part ${event.partIndex}/${event.partsTotal} | Slice ${event.partHours} clock h | Remaining ${event.remainingHours} man-h of ${event.manHours} man-h (total clock ${event.clockHoursTotal}h)`
              : `${event.manHours} man-h (clock ${event.clockHoursTotal}h)`;
      const travelInfo = (event.travelOutMinutes || event.travelReturnMinutes) ? `Travel Out: ${event.travelOutMinutes||0}m | Return: ${event.travelReturnMinutes||0}m` : '';
      const tooltip = `${event.jobLabel} \n${partsInfo}${travelInfo?`\n${travelInfo}`:''}`;
            return (
              <span title={tooltip} style={{ position:'relative', paddingRight:14, display:'inline-block', maxWidth:'100%' }}>
                {event.jobLabel}
        {travelInfo && <span style={{ display:'block', fontSize:9, opacity:0.85 }}>{travelInfo}</span>}
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
            backgroundColor: event.nonCore ? '#555' : (event.color || '#3174ad'),
            border: event.nonCore ? '1px dashed #222' : '1px solid rgba(0,0,0,0.25)',
            color: '#fff',
            fontSize: 12,
            padding: 2,
            borderRadius: 4,
            opacity: event.nonCore ? 0.8 : 0.95,
            boxShadow: event.nonCore ? 'inset 0 0 0 2px rgba(255,255,255,0.15)' : undefined
          };
          return { style };
        }}
        dayPropGetter={(date)=>{
          const holidays = Array.isArray(schedSettings?.holidays) ? schedSettings.holidays : [];
          const ds = date.toISOString().slice(0,10);
          if (holidays.includes(ds)) {
            return { style: { backgroundColor: '#fff2f2' } };
          }
          return {};
        }}
        slotPropGetter={(date)=>{
          try {
            if(!schedSettings || !schedSettings.availability || !Array.isArray(selectedInstallers) || selectedInstallers.length===0) return {};
            const day = date.toISOString().slice(0,10);
            const hour = date.getHours();
            const allOut = selectedInstallers.every(instId=>{
              const instAvailDay = (schedSettings.availability[instId]||{})[day];
              if(!instAvailDay) return false; // no record means available
              if(instAvailDay.out) return true;
              if(instAvailDay.outHours && Array.isArray(instAvailDay.outHours)) return instAvailDay.outHours.includes(hour);
              return false;
            });
            if(allOut){
              return { style: { backgroundColor: '#ffe9e9' } };
            }
            return {};
          } catch(err){
            return {};
          }
        }}
      />
      {/* Daily hours summary sidebar - only in Day view, draggable */}
      {currentView === 'day' && (
        <div
          style={{
            position: 'fixed',
            top: sidebarState.y ?? 0,
            left: sidebarState.pinned ? 'auto' : Math.min(Math.max(0, sidebarState.x ?? (window.innerWidth - 230)), window.innerWidth - 240),
            right: sidebarState.pinned ? 0 : 'auto',
            width: 230,
            maxHeight: '90vh',
            background: '#fafafa',
            border: '1px solid #ccc',
            borderRight: sidebarState.pinned ? 'none' : '1px solid #ccc',
            boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
            padding: '4px 8px 8px',
            overflowY: 'auto',
            fontSize: 11,
            zIndex: 1500,
            cursor: sidebarState.dragging ? 'grabbing' : 'default'
          }}
        >
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:4 }}>
            <div onMouseDown={startDragSidebar} style={{ fontWeight:600, fontSize:13, cursor:'grab', userSelect:'none' }}>Daily Hours</div>
            <button style={{ fontSize:10 }} onClick={()=>setSidebarState(s=>({...s, pinned: !s.pinned, x: s.pinned? (s.x ?? (window.innerWidth - 230)) : null }))}>{sidebarState.pinned? 'Float':'Dock'}</button>
          </div>
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
      )}
    {(selected || showForm || showSettings) && (
        <>
      <div onClick={() => { setSelected(null); setShowForm(false); setShowSettings(false); }} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000 }} />
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
                          const perInstallerClock = form.man_hours && candidateIds.length ? Number(form.man_hours)/candidateIds.length : 0; // elapsed per installer
                          const wouldExceed = assigned + perInstallerClock > 8.0001;
                          // Allow choosing an installer with zero current hours even if job >8 man-hours (will span multiple days). Disable only if existing hours cause exceedance.
                          const disabled = !overrideDailyLimit && !form.installers.includes(i.id) && wouldExceed && assigned > 0;
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
                    {overlapConflict && !overrideDailyLimit && (
                      <div style={{ background:'#e3f2fd', border:'1px solid #90caf9', color:'#0d47a1', padding:'6px 8px', borderRadius:4, fontSize:12, marginBottom:6 }}>
                        Time overlap with another assignment for a selected installer. Adjust, change installers, or override.
                      </div>
                    )}
                      {weekendBlocked && (
                        <div style={{ background:'#fdecea', border:'1px solid #f5c2c0', color:'#b71c1c', padding:'6px 8px', borderRadius:4, fontSize:12, marginBottom:6 }}>
                          Weekend date requires "Allow work outside core hours" override.
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
                        const perInstallerClock = form.man_hours && candidateIds.length ? Number(form.man_hours) / candidateIds.length : 0;
                        const wouldExceed = assigned + perInstallerClock > 8.0001;
                        const disabled = !overrideDailyLimit && !form.installers.includes(i.id) && wouldExceed && assigned > 0;
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
                  {(weekendBlocked || (isHoliday && !form.core_hours_override)) && (
                    <div style={{ background:'#fdecea', border:'1px solid #f5c2c0', color:'#b71c1c', padding:'6px 8px', borderRadius:4, fontSize:12, marginBottom:6 }}>
                      {(isHoliday? 'Holiday':'Weekend')} date requires outside core hours override.
                    </div>
                  )}
                    {(availabilityBlocked || availabilityPartialConflict) && !(overrideDailyLimit || overrideAvailability) && (
                    <div style={{ background:'#fff3cd', border:'1px solid #ffeeba', color:'#856404', padding:'6px 8px', borderRadius:4, fontSize:12, marginBottom:6 }}>
                      One or more selected installers are marked out.
                    </div>
                  )}
                  <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                    <label style={{ cursor: 'pointer' }}>
                      <input type="checkbox" checked={overrideDailyLimit} onChange={e => setOverrideDailyLimit(e.target.checked)} style={{ marginRight: 6 }} /> Override 8h daily limit
                    </label>
                    <label style={{ cursor: 'pointer' }}>
                      <input type="checkbox" checked={overrideAvailability} onChange={e => setOverrideAvailability(e.target.checked)} style={{ marginRight: 6 }} /> Override availability
                    </label>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <button type="submit" disabled={(exceed && !overrideDailyLimit) || weekendBlocked || (overlapConflict && !overrideDailyLimit)}>Save</button>
                  <button type="button" style={{ marginLeft: 8 }} onClick={() => setShowForm(false)}>Cancel</button>
                </div>
              </form>
            </div>
          )}
          {showSettings && (
            <div style={{ position: 'fixed', top: '12%', left: '50%', transform: 'translateX(-50%)', width: '80%', maxWidth: 480, background: '#fff', borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.3)', padding: 20, zIndex: 1001 }}>
              <h3 style={{ marginTop:0 }}>Scheduling Settings</h3>
              <form onSubmit={async e=>{ e.preventDefault();
                const payload = {
                  core_start_hour: Number(settingsForm.core_start_hour)||0,
                  core_end_hour: Number(settingsForm.core_end_hour)||0,
                  drive_out_minutes: Number(settingsForm.drive_out_minutes)||0,
                  drive_return_minutes: Number(settingsForm.drive_return_minutes)||0
                };
                if (payload.core_end_hour <= payload.core_start_hour) { alert('End hour must be greater than start hour'); return; }
                try {
                  const res = await fetch('/api/settings/scheduling', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
                  if (!res.ok) throw new Error(`Save failed (${res.status})`);
                  CORE_START_HOUR = payload.core_start_hour; CORE_END_HOUR = payload.core_end_hour;
                  setSchedSettings(s=>({...s, ...payload}));
                  setShowSettings(false);
                  await loadSchedules();
                } catch(err){ alert(err.message); }
              }}>
                <div style={{ display:'flex', flexWrap:'wrap', gap:16 }}>
                  <label style={{ flex:'1 1 120px' }}>Core Start Hour<br />
                    <input type="number" min="0" max="23" value={settingsForm.core_start_hour} onChange={e=>setSettingsForm(f=>({...f, core_start_hour:e.target.value}))} style={{ width:'100%' }} />
                  </label>
                  <label style={{ flex:'1 1 120px' }}>Core End Hour<br />
                    <input type="number" min="0" max="23" value={settingsForm.core_end_hour} onChange={e=>setSettingsForm(f=>({...f, core_end_hour:e.target.value}))} style={{ width:'100%' }} />
                  </label>
                  <label style={{ flex:'1 1 140px' }}>Drive Out (min)<br />
                    <input type="number" min="0" value={settingsForm.drive_out_minutes} onChange={e=>setSettingsForm(f=>({...f, drive_out_minutes:e.target.value}))} style={{ width:'100%' }} />
                  </label>
                  <label style={{ flex:'1 1 140px' }}>Drive Return (min)<br />
                    <input type="number" min="0" value={settingsForm.drive_return_minutes} onChange={e=>setSettingsForm(f=>({...f, drive_return_minutes:e.target.value}))} style={{ width:'100%' }} />
                  </label>
                </div>
                <div style={{ textAlign:'right', marginTop:18 }}>
                  <button type="submit">Save</button>
                  <button type="button" style={{ marginLeft:8 }} onClick={()=>setShowSettings(false)}>Cancel</button>
                </div>
              </form>
              <div style={{ marginTop:12, fontSize:11, color:'#555' }}>Changes apply to future slicing immediately after save; existing events are regenerated.</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
