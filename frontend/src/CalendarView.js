import React, { useEffect, useState, useMemo } from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { format, parse, startOfWeek, getDay } from 'date-fns';

const locales = {
  'en-US': require('date-fns/locale/en-US')
};
const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 0 }),
  getDay,
  locales
});

function getEventTimes(job) {
  // Try to parse start/end time from job fields, fallback to all-day
  // Accepts ISO strings or 'YYYY-MM-DD HH:mm' format
  let start = job.start || job.date || job['Promise Date'] || job['Date Setup'];
  let end = job.end || start;
  if (job.start_time && job.end_time) {
    return { start: new Date(job.start_time), end: new Date(job.end_time) };
  }
  // Always convert start and end to Date objects
  if (!(start instanceof Date)) start = new Date(start);
  if (!(end instanceof Date)) end = new Date(end);
  const coreStartHour = 8; // 8am
  const coreEndHour = 16; // 4pm
  const coreHoursPerDay = coreEndHour - coreStartHour;
  // If start is invalid, fallback to today at coreStartHour
  if (isNaN(start.getTime())) {
    const dateStr = job.date ? job.date.slice(0, 10) : null;
    start = dateStr ? new Date(dateStr + 'T' + String(coreStartHour).padStart(2, '0') + ':00:00') : new Date();
    start.setHours(coreStartHour, 0, 0, 0);
  }
  // Set end to start for duration calculation
  end = new Date(start);
  let nInstallers = Array.isArray(job.installers) ? job.installers.length : (job.installers ? 1 : 1);
  if (nInstallers === 0) nInstallers = 1;
  const manHours = Number(job.man_hours) || 0;
  let durationHours = nInstallers > 0 ? manHours / nInstallers : manHours;
  let hoursLeft = durationHours;
  // Core hours override: if job.core_hours_override is true, allow any hours in the day
  const coreOverride = job.core_hours_override;
  if (coreOverride) {
    // Just add hours directly, no core hour restriction
    end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);
    return { start, end };
  }
  while (hoursLeft > 0) {
    const availableToday = coreEndHour - end.getHours();
    if (hoursLeft <= availableToday) {
      end.setHours(end.getHours() + hoursLeft);
      hoursLeft = 0;
    } else {
      hoursLeft -= availableToday;
      end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
      end.setHours(coreStartHour, 0, 0, 0);
    }
  }
  return { start, end };
}


export default function CalendarView() {
  const [installers, setInstallers] = useState([]);
  useEffect(() => {
    fetch('/api/installers')
      .then(res => res.json())
      .then(setInstallers);
  }, []);

  const [events, setEvents] = useState([]);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: '', job_number: '', date: '', description: '', man_hours: '', installers: [], core_hours_override: false });
  const [jobNumbers, setJobNumbers] = useState([]);
  const [jobNumberQuery, setJobNumberQuery] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editManHours, setEditManHours] = useState('');
  const [editInstallers, setEditInstallers] = useState([]);
  const [overrideLimit, setOverrideLimit] = useState(false);
  const [editOverrideLimit, setEditOverrideLimit] = useState(false);
  const [editCoreHoursOverride, setEditCoreHoursOverride] = useState(false);

  // Helper: get total man-hours for an installer on a given date (excluding current job if editing)
  function getInstallerHours(installerId, date, excludeJobId = null) {
  return events
    .filter(ev => Array.isArray(ev.resource.installers) && ev.resource.installers.includes(installerId) &&
      ev.resource.date &&
      ev.resource.date.slice(0, 10) === (date ? date.slice(0, 10) : '') &&
      (excludeJobId == null || ev.resource.id !== excludeJobId)
    )
    .reduce((sum, ev) => {
      const n = Array.isArray(ev.resource.installers) ? ev.resource.installers.length : 1;
      return sum + ((Number(ev.resource.man_hours) || 0) / n);
    }, 0);
  }

  // Helper: check if assigning installer would exceed 8 hours
  function wouldExceedLimit(installerIds, date, manHours, excludeJobId = null) {
    if (!installerIds || !date || !manHours) return false;
    const ids = Array.isArray(installerIds) ? installerIds : [installerIds];
    const perInstaller = Number(manHours) / (ids.length || 1);
    return ids.some(id => getInstallerHours(id, date, excludeJobId) + perInstaller > 8);
  }

  // Fetch jobs
  const fetchEvents = () => {
    fetch('/api/schedules')
      .then(res => res.json())
      .then(data => {
        setEvents(data.map(job => {
          const { start, end } = getEventTimes(job);
          // Use [job number] [description] as title everywhere
          const jobLabel = `${job.job_number || ''} ${job.description || ''}`.trim();
          // Calculate man-hours if possible (fallback to 0)
          const manHours = Number(job.man_hours) || 0;
          return {
            id: job.id,
            title: jobLabel,
            start,
            end,
            allDay: start.getHours() === 0 && end.getHours() === 0,
            resource: { ...job, man_hours: manHours },
            jobLabel,
            manHours
          };
        }));
        setJobNumbers(data.map(job => job.job_number).filter(Boolean));
      });
  };

  useEffect(() => {
    fetchEvents();
  }, []);

  // Show job details in a modal
  const handleSelectEvent = event => {
    setSelectedEvent(event.resource);
    setEditDesc(event.resource.description || '');
    setEditManHours(
      event.resource.man_hours !== undefined && event.resource.man_hours !== null
        ? String(event.resource.man_hours)
        : ''
    );
    // Support multiple installers
    if (Array.isArray(event.resource.installers)) {
      setEditInstallers(event.resource.installers);
    } else if (event.resource.installer_id) {
      setEditInstallers([event.resource.installer_id]);
    } else {
      setEditInstallers([]);
    }
    setEditCoreHoursOverride(!!event.resource.core_hours_override);
  };

  // Fetch job info by job number and show in modal
  const handleJobNumberSelect = async (jobNumber) => {
    if (!jobNumber) return;
    const res = await fetch(`/api/schedules/${encodeURIComponent(jobNumber)}`);
    if (res.ok) {
      const job = await res.json();
      setSelectedEvent(job);
    } else {
      setSelectedEvent(null);
      alert('Job not found');
    }
  };

  // Allow creating a new job from calendar
  const handleSelectSlot = slotInfo => {
    setForm({ title: '', job_number: '', date: slotInfo.start.toISOString().slice(0, 16), description: '' });
    setShowForm(true);
  };

  const handleFormChange = e => {
    const { name, value, type, options, checked } = e.target;
    if (name === 'installers') {
      const selected = Array.from(options).filter(o => o.selected).map(o => Number(o.value));
      setForm({ ...form, installers: selected });
    } else if (name === 'core_hours_override') {
      setForm({ ...form, core_hours_override: checked });
    } else {
      setForm({ ...form, [name]: value });
    }
  };

  const handleFormSubmit = async e => {
    e.preventDefault();
    // Ensure man_hours is a number or empty string
    const submitForm = { ...form, man_hours: form.man_hours ? Number(form.man_hours) : '', installers: form.installers, core_hours_override: !!form.core_hours_override };
    await fetch('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submitForm)
    });
    setShowForm(false);
    fetchEvents();
  };

  // Allow editing job (description, man_hours, installers)
  const handleEdit = async () => {
    if (!selectedEvent) return;
    await fetch(`/api/schedules/${selectedEvent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: editDesc,
        man_hours: editManHours !== '' ? Number(editManHours) : undefined,
        installers: editInstallers,
        core_hours_override: !!editCoreHoursOverride
      })
    });
    setSelectedEvent(null);
    fetchEvents();
  };

  return (
    <div style={{ height: 600, position: 'relative' }}>
      {/* Job number search/select */}
      <div style={{ marginBottom: 10 }}>
        <label>
          Search by Job Number:{' '}
          <input
            list="job-numbers"
            value={jobNumberQuery}
            onChange={e => setJobNumberQuery(e.target.value)}
            placeholder="Enter or select job number"
            style={{ width: 180 }}
          />
          <datalist id="job-numbers">
            {events
              .filter(ev => ev.resource && ev.resource.job_number)
              .sort((a, b) => {
                const an = Number(a.resource.job_number), bn = Number(b.resource.job_number);
                if (!isNaN(an) && !isNaN(bn)) return an - bn;
                return String(a.resource.job_number).localeCompare(String(b.resource.job_number));
              })
              .map(ev => (
                <option key={ev.resource.job_number} value={ev.resource.job_number} label={`${ev.resource.job_number} ${ev.resource.description || ''}`} />
              ))}
          </datalist>
        </label>
        <button
          style={{ marginLeft: 8 }}
          onClick={() => handleJobNumberSelect(jobNumberQuery)}
          disabled={!jobNumberQuery}
        >
          Go
        </button>
      </div>
      <Calendar
        localizer={localizer}
        events={events}
        startAccessor="start"
        endAccessor="end"
        style={{ height: 600 }}
        popup
        selectable
        onSelectEvent={handleSelectEvent}
        onSelectSlot={handleSelectSlot}
        eventPropGetter={event => {
          if (event.manHours && event.manHours > 0) {
            return { style: { backgroundColor: '#ffe066', color: '#333' } };
          }
          return {};
        }}
        components={{
          event: ({ event }) => (
            <span
              title={JSON.stringify(event.resource, null, 2)}
              style={{ cursor: 'pointer', textDecoration: 'underline dotted' }}
            >
              {event.jobLabel}
            </span>
          )
        }}
      />
      {/* Event details modal */}
      {selectedEvent && (
        <div style={{ position: 'absolute', top: 40, left: '10%', right: '10%', background: '#fff', border: '1px solid #888', padding: 20, zIndex: 10 }}>
          <h3>{selectedEvent.job_number} {selectedEvent.description}</h3>
          <div><b>Date:</b> {selectedEvent.date}</div>
          <div><b>Description:</b> {selectedEvent.description}</div>
          <div><b>Estimated Man-Hours:</b> {selectedEvent.man_hours || 0}</div>
          <div><b>Assigned Installers:</b> {Array.isArray(selectedEvent.installers) && selectedEvent.installers.length > 0
            ? selectedEvent.installers.map(id => {
                const inst = installers.find(i => i.id === id);
                return inst ? inst.name : null;
              }).filter(Boolean).join(', ')
            : 'None'}</div>
          {/* Show all fields for the job */}
          <div style={{ marginTop: 10 }}>
            <b>All Info:</b>
            <pre style={{ background: '#f6f6f6', padding: 8, maxHeight: 200, overflow: 'auto' }}>{JSON.stringify(selectedEvent, null, 2)}</pre>
          </div>
          <div style={{ marginTop: 10 }}>
            <input
              value={editDesc}
              onChange={e => setEditDesc(e.target.value)}
              placeholder="Edit description"
              style={{ marginRight: 8 }}
            />
            <input
              value={editManHours}
              onChange={e => setEditManHours(e.target.value)}
              placeholder="Edit man-hours"
              type="number"
              min="0"
              step="0.1"
              style={{ marginRight: 8, width: 100 }}
            />
            <select
              multiple
              value={editInstallers}
              onChange={e => {
                const selected = Array.from(e.target.options).filter(o => o.selected).map(o => Number(o.value));
                setEditInstallers(selected);
              }}
              style={{ marginRight: 8, minWidth: 180, height: 80 }}
            >
              {installers.map(i => {
                  const disabled = !editOverrideLimit && wouldExceedLimit([...(editInstallers || []).filter(id => id !== i.id), i.id], selectedEvent?.date, editManHours, selectedEvent?.id);
                  const assigned = getInstallerHours(i.id, selectedEvent?.date, selectedEvent?.id);
                  return (
                    <option key={i.id} value={i.id} disabled={disabled && !(editInstallers || []).includes(i.id)}>
                      {i.name} {assigned ? `(assigned: ${assigned}h)` : ''} {disabled && !(editInstallers || []).includes(i.id) ? ' (limit)' : ''}
                    </option>
                  );
                })}
            </select>
            <label style={{ marginLeft: 8 }}>
              <input
                type="checkbox"
                checked={editCoreHoursOverride}
                onChange={e => setEditCoreHoursOverride(e.target.checked)}
              /> Allow work outside core hours
            </label>
            {/* Override checkbox and warning */}
            {editInstallers.length > 0 && wouldExceedLimit(editInstallers, selectedEvent?.date, editManHours, selectedEvent?.id) && (
              <span style={{ color: 'red', marginRight: 8 }}>
                Over 8h! <label><input type="checkbox" checked={editOverrideLimit} onChange={e => setEditOverrideLimit(e.target.checked)} /> Override</label>
              </span>
            )}
            <button onClick={handleEdit} disabled={editInstallers.length > 0 && wouldExceedLimit(editInstallers, selectedEvent?.date, editManHours, selectedEvent?.id) && !editOverrideLimit}>Save</button>
            <button onClick={() => setSelectedEvent(null)}>Close</button>
          </div>
        </div>
      )}
      {/* New job form modal */}
      {showForm && (
        <div style={{ position: 'absolute', top: 40, left: '10%', right: '10%', background: '#fff', border: '1px solid #888', padding: 20, zIndex: 10 }}>
          <h3>New Job</h3>
          <form onSubmit={handleFormSubmit}>
            {/* Job number and description as one label */}
            <div style={{ margin: '8px 0' }}>
              <label>
                Job Number:
                <input
                  name="job_number"
                  value={form.job_number}
                  onChange={handleFormChange}
                  placeholder="Job Number"
                  list="job-number-list"
                  required
                  style={{ marginLeft: 8, width: 180 }}
                />
                <datalist id="job-number-list">
                  {events
                    .filter(ev => ev.resource && ev.resource.job_number)
                    .sort((a, b) => {
                      const an = Number(a.resource.job_number), bn = Number(b.resource.job_number);
                      if (!isNaN(an) && !isNaN(bn)) return an - bn;
                      return String(a.resource.job_number).localeCompare(String(b.resource.job_number));
                    })
                    .map(ev => (
                      <option key={ev.resource.job_number} value={ev.resource.job_number} label={`${ev.resource.job_number} ${ev.resource.description || ''}`} />
                    ))}
                </datalist>
              </label>
            </div>
            <input name="description" value={form.description} onChange={handleFormChange} placeholder="Description" />
            <div style={{ margin: '8px 0' }}>
              <label>
                Estimated Man-Hours:
                <input
                  name="man_hours"
                  value={form.man_hours}
                  onChange={handleFormChange}
                  placeholder="e.g. 8"
                  type="number"
                  min="0"
                  step="0.1"
                  style={{ marginLeft: 8, width: 100 }}
                />
              </label>
            </div>
            <input name="date" value={form.date} onChange={handleFormChange} type="datetime-local" required />
            <select
              name="installers"
              multiple
              value={form.installers}
              onChange={handleFormChange}
              style={{ marginRight: 8, minWidth: 180, height: 80 }}
            >
              {installers.map(i => {
                const disabled = !overrideLimit && wouldExceedLimit([...(form.installers || []).filter(id => id !== i.id), i.id], form.date, form.man_hours);
                const assigned = getInstallerHours(i.id, form.date);
                return (
                  <option key={i.id} value={i.id} disabled={disabled && !form.installers.includes(i.id)}>
                    {i.name} {assigned ? `(assigned: ${assigned}h)` : ''} {disabled && !form.installers.includes(i.id) ? ' (limit)' : ''}
                  </option>
                );
              })}
            </select>
            <label style={{ marginLeft: 8 }}>
              <input
                type="checkbox"
                name="core_hours_override"
                checked={form.core_hours_override}
                onChange={handleFormChange}
              /> Allow work outside core hours
            </label>
            {/* Override checkbox and warning */}
            {form.installers && form.installers.length > 0 && wouldExceedLimit(form.installers, form.date, form.man_hours) && (
              <span style={{ color: 'red', marginRight: 8 }}>
                Over 8h! <label><input type="checkbox" checked={overrideLimit} onChange={e => setOverrideLimit(e.target.checked)} /> Override</label>
              </span>
            )}
            <button type="submit" disabled={form.installers && form.installers.length > 0 && wouldExceedLimit(form.installers, form.date, form.man_hours) && !overrideLimit}>Save</button>
            <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
          </form>
        </div>
      )}
    </div>
  );
}
