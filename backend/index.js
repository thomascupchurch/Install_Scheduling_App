import 'dotenv/config';
import express from 'express';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import multer from 'multer';
import XLSX from 'xlsx';
import nodemailer from 'nodemailer';
import fetch from 'node-fetch';
import crypto from 'crypto';

const ORS_API_KEY = process.env.ORS_API_KEY || 'REPLACE_ME';

const app = express();
const port = process.env.PORT || 3001;
const upload = multer({ dest: 'uploads/' });

app.use(express.json());

// Startup warnings
if (!process.env.ORS_API_KEY) {
  console.warn('[WARN] ORS_API_KEY not set. Driving time requests will return error until provided.');
}

// Health / config status endpoint
app.get('/api/health', (req,res)=> {
  res.json({
    ok: true,
    orsConfigured: !!process.env.ORS_API_KEY,
    time: new Date().toISOString()
  });
});

// Database setup

let db;
(async () => {
  db = await open({
    filename: './schedules.db',
    driver: sqlite3.Database
  });
  // Schedules table
  await db.exec(`CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_number TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    description TEXT,
  man_hours REAL,
  core_hours_override INTEGER DEFAULT 0,
  override_hours INTEGER DEFAULT 0,
  override_availability INTEGER DEFAULT 0,
  address TEXT,
  source_type TEXT, -- 'pace' or 'csv'
  customer_name TEXT,
  building_name TEXT,
  onsite_contact_first TEXT,
  onsite_contact_last TEXT,
  onsite_contact_phone TEXT,
  salesperson TEXT,
  project_manager TEXT,
  project_manager_phone TEXT,
  notes TEXT,
  file_ref TEXT
  )`);
  // Add columns for migration if missing
  try { await db.exec('ALTER TABLE schedules ADD COLUMN man_hours REAL'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN start_time TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN end_time TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN address TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN core_hours_override INTEGER DEFAULT 0'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN override_hours INTEGER DEFAULT 0'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN override_availability INTEGER DEFAULT 0'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN source_type TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN customer_name TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN building_name TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN onsite_contact_first TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN onsite_contact_last TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN onsite_contact_phone TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN salesperson TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN project_manager TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN project_manager_phone TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN notes TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN file_ref TEXT'); } catch {}
  // Rename legacy csv source_type to install_request if present
  try { await db.run("UPDATE schedules SET source_type='install_request' WHERE source_type='csv'"); } catch {}
  // Additional columns for enriching with Pace data (without creating jobs from Pace directly going forward)
  try { await db.exec('ALTER TABLE schedules ADD COLUMN pace_title TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN pace_date TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN pace_description TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN pace_man_hours REAL'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN pace_address TEXT'); } catch {}
  // Pending jobs table for unscheduled install requests
  await db.exec(`CREATE TABLE IF NOT EXISTS pending_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_number TEXT UNIQUE NOT NULL,
    title TEXT,
    description TEXT,
    address TEXT,
    source_type TEXT,
    customer_name TEXT,
    building_name TEXT,
    onsite_contact_first TEXT,
    onsite_contact_last TEXT,
    onsite_contact_phone TEXT,
    salesperson TEXT,
    project_manager TEXT,
    project_manager_phone TEXT,
    notes TEXT,
    file_ref TEXT,
    man_hours REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  try { await db.exec('ALTER TABLE pending_jobs ADD COLUMN man_hours REAL'); } catch {}
  // Installers table
  await db.exec(`CREATE TABLE IF NOT EXISTS installers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT
  )`);
  // Migration: add email column if missing
  try { await db.exec('ALTER TABLE installers ADD COLUMN email TEXT'); } catch {}
  // Many-to-many: schedule_installers
  await db.exec(`CREATE TABLE IF NOT EXISTS schedule_installers (
    schedule_id INTEGER,
    installer_id INTEGER,
    PRIMARY KEY (schedule_id, installer_id),
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
    FOREIGN KEY (installer_id) REFERENCES installers(id) ON DELETE CASCADE
  )`);
  // New: slices table for multi-day spillover (per installer clock hours, not total man-hours)
  await db.exec(`CREATE TABLE IF NOT EXISTS schedule_slices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL,
    slice_index INTEGER NOT NULL,
    date TEXT NOT NULL,           -- ISO start datetime of this slice
    duration_hours REAL NOT NULL, -- clock hours for this slice (per-installer clock time span)
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
  )`);
  // Backfill slices for existing schedules that lack them (one-time on startup)
  async function backfillSlices() {
    const coreStartRow = await db.get('SELECT value FROM settings WHERE key=?',[ 'core_start_hour' ]);
    const coreEndRow = await db.get('SELECT value FROM settings WHERE key=?',[ 'core_end_hour' ]);
    const coreStart = Number(coreStartRow?.value || 8);
    const coreEnd = Number(coreEndRow?.value || 16);
    const holidaysRow = await db.get('SELECT value FROM settings WHERE key=?',['holidays']);
    let holidays = [];
    if (holidaysRow?.value) { try { holidays = JSON.parse(holidaysRow.value); } catch { holidays = []; } }
    const schedulesAll = await db.all('SELECT * FROM schedules');
    for (const sched of schedulesAll) {
      const sliceCount = await db.get('SELECT COUNT(*) as c FROM schedule_slices WHERE schedule_id=?',[sched.id]);
      if (sliceCount.c > 0) continue; // already have slices
      const installersRows = await db.all('SELECT installer_id FROM schedule_installers WHERE schedule_id=?',[sched.id]);
      const installerIds = installersRows.map(r=>r.installer_id);
      const n = installerIds.length || 1;
      const perClockTotal = (Number(sched.man_hours)||0) / n;
      if (!perClockTotal) continue;
      if (sched.core_hours_override || sched.override_hours) {
        await db.run('INSERT INTO schedule_slices (schedule_id, slice_index, date, duration_hours) VALUES (?,?,?,?)', [sched.id, 0, sched.date, perClockTotal]);
        continue;
      }
      let remaining = perClockTotal;
      let idx = 0;
      let cursor = new Date(sched.date);
      if (isNaN(cursor.getTime())) continue;
      if (cursor.getHours() < coreStart) cursor.setHours(coreStart,0,0,0);
      while (remaining > 0 && idx < 100) {
        const dayKey = cursor.toISOString().slice(0,10);
        const isWeekend = cursor.getDay()===0 || cursor.getDay()===6 || holidays.includes(dayKey);
        let windowStart = new Date(cursor);
        if (idx>0) {
          if (isWeekend) windowStart.setHours(0,0,0,0); else windowStart.setHours(coreStart,0,0,0);
        }
        let windowEnd = new Date(windowStart);
        if (isWeekend) windowEnd.setDate(windowEnd.getDate()+1); else windowEnd.setHours(coreEnd,0,0,0);
        const avail = (windowEnd - windowStart)/3600000;
        if (avail <= 0) { cursor = new Date(cursor.getTime()+24*3600000); idx++; continue; }
        const sliceHours = Math.min(remaining, avail);
        await db.run('INSERT INTO schedule_slices (schedule_id, slice_index, date, duration_hours) VALUES (?,?,?,?)', [sched.id, idx, windowStart.toISOString(), sliceHours]);
        remaining -= sliceHours;
        cursor = new Date(windowStart); cursor.setDate(cursor.getDate()+1); idx++;
      }
    }
  }
  try { await backfillSlices(); } catch (e) { console.error('Slice backfill error', e); }
  // Settings table for home base
  await db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
  // Sent calendar events tracking (per schedule per installer) for ICS UID/sequence
  await db.exec(`CREATE TABLE IF NOT EXISTS calendar_events_sent (
    schedule_id INTEGER,
    installer_id INTEGER,
    uid TEXT,
    sequence INTEGER DEFAULT 0,
    last_sent TEXT,
    PRIMARY KEY (schedule_id, installer_id),
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
    FOREIGN KEY (installer_id) REFERENCES installers(id) ON DELETE CASCADE
  )`);
  try { await db.exec('ALTER TABLE calendar_events_sent ADD COLUMN last_sent TEXT'); } catch {}
  // Drive time & geocode caches
  await db.exec(`CREATE TABLE IF NOT EXISTS drive_time_cache (
    origin TEXT,
    destination TEXT,
    minutes INTEGER,
    distance REAL,
    fetched_at TEXT,
    PRIMARY KEY(origin, destination)
  )`);
  try { await db.exec('ALTER TABLE drive_time_cache ADD COLUMN distance REAL'); } catch {}
  await db.exec(`CREATE TABLE IF NOT EXISTS geocode_cache (
    address TEXT PRIMARY KEY,
    lon REAL,
    lat REAL,
    fetched_at TEXT
  )`);
  // Seed defaults if not existing
  const defaults = [
    ['core_start_hour', '8'],
    ['core_end_hour', '16'],
    ['drive_out_minutes', '0'],
    ['drive_return_minutes', '0']
  ];
  for (const [k,v] of defaults) {
    const row = await db.get('SELECT 1 FROM settings WHERE key=?',[k]);
    if (!row) await db.run('INSERT INTO settings (key,value) VALUES (?,?)',[k,v]);
  }
})();

// Home base API
app.get('/api/settings/home_base', async (req, res) => {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', ['home_base']);
  res.json({ home_base: row ? row.value : '' });
});

app.post('/api/settings/home_base', async (req, res) => {
  const { home_base } = req.body;
  await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['home_base', home_base]);
  res.json({ success: true });
});

// Core hours & drive settings
app.get('/api/settings/scheduling', async (req, res) => {
  const keys = ['core_start_hour','core_end_hour','drive_out_minutes','drive_return_minutes','holidays','availability'];
  const out = {};
  for (const k of keys) {
    const row = await db.get('SELECT value FROM settings WHERE key=?',[k]);
    out[k] = row ? row.value : null;
  }
  // holidays stored as JSON string
  if (out.holidays) {
    try { out.holidays = JSON.parse(out.holidays); } catch { out.holidays = []; }
  } else out.holidays = [];
  if (out.availability) {
    try { out.availability = JSON.parse(out.availability); } catch { out.availability = {}; }
  } else out.availability = {};
  res.json(out);
});
app.post('/api/settings/scheduling', async (req, res) => {
  const { core_start_hour, core_end_hour, drive_out_minutes, drive_return_minutes, holidays, availability } = req.body;
  const entries = { core_start_hour, core_end_hour, drive_out_minutes, drive_return_minutes };
  try {
    for (const [k,v] of Object.entries(entries)) {
      if (v !== undefined) {
        await db.run('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)',[k,String(v)]);
      }
    }
    if (holidays) {
      await db.run('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)',['holidays', JSON.stringify(holidays)]);
    }
    if (availability) {
      await db.run('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)',['availability', JSON.stringify(availability)]);
    }
    res.json({ success:true });
  } catch(e){ res.status(400).json({ error: e.message }); }
});

// Update job address
app.patch('/api/schedules/:id/address', async (req, res) => {
  const { address } = req.body;
  await db.run('UPDATE schedules SET address = ? WHERE id = ?', [address, req.params.id]);
  res.json({ success: true });
});


// Schedules routes
app.get('/api/schedules', async (req, res) => {
  // Get all jobs with their installers
  const schedules = await db.all('SELECT * FROM schedules');
  for (const job of schedules) {
    const installers = await db.all('SELECT installer_id FROM schedule_installers WHERE schedule_id = ?', [job.id]);
    job.installers = installers.map(i => i.installer_id);
  // attach slices
  const slices = await db.all('SELECT slice_index, date, duration_hours FROM schedule_slices WHERE schedule_id = ? ORDER BY slice_index', [job.id]);
  job.slices = slices;
  }
  res.json(schedules);
});

// Get schedule by job number
app.get('/api/schedules/:job_number', async (req, res) => {
  const job_number = req.params.job_number;
  const job = await db.get('SELECT * FROM schedules WHERE job_number = ?', [job_number]);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const installers = await db.all('SELECT installer_id FROM schedule_installers WHERE schedule_id = ?', [job.id]);
  job.installers = installers.map(i => i.installer_id);
  const slices = await db.all('SELECT slice_index, date, duration_hours FROM schedule_slices WHERE schedule_id = ? ORDER BY slice_index', [job.id]);
  job.slices = slices;
  res.json(job);
});

app.post('/api/schedules', async (req, res) => {
  try {
  const { job_number, title, start_time, end_time, description, installers, man_hours, override, core_hours_override, override_availability } = req.body;
  const rule_overrides = [];
  if (override) rule_overrides.push('hours_or_overlap');
  if (override_availability) rule_overrides.push('availability');
  if (core_hours_override) rule_overrides.push('core_hours');
    let { date } = req.body; // allow mutation for weekend auto-shift
    let original_date = date;
  let shiftedWeekend = false;
  let shiftedHoliday = false;
    // Weekend handling: auto-shift to next Monday if weekend and no override flags
    if (date) {
      const d = new Date(date);
      if (!isNaN(d.getTime())) {
        const dow = d.getDay();
        // Load holidays list
        const holidaysRow = await db.get('SELECT value FROM settings WHERE key=?',['holidays']);
        let holidays = [];
        if (holidaysRow?.value) { try { holidays = JSON.parse(holidaysRow.value); } catch { holidays = []; } }
        const dateStr = d.toISOString().slice(0,10);
        const isHoliday = holidays.includes(dateStr);
        if (((dow === 0 || dow === 6) || isHoliday) && !override && !core_hours_override) {
          // Move forward to next non-weekend, non-holiday weekday
          while (true) {
            const dow2 = d.getDay();
            const ds = d.toISOString().slice(0,10);
            const holidayNow = holidays.includes(ds);
            if (dow2 !== 0 && dow2 !== 6 && !holidayNow) break;
            d.setDate(d.getDate() + 1);
          }
          date = d.toISOString().slice(0,16);
          if (dow === 0 || dow === 6) shiftedWeekend = true; else shiftedHoliday = true;
        }
      }
    }
    // Availability enforcement (before hour limit/overlap) unless overridden
    if (Array.isArray(installers) && installers.length && man_hours && !(override || override_availability)) {
      const availabilityRow = await db.get('SELECT value FROM settings WHERE key=?',[ 'availability' ]);
      let availability = {};
      if (availabilityRow?.value) { try { availability = JSON.parse(availabilityRow.value); } catch { availability = {}; } }
      const dayStr = date.slice(0,10);
      // derive working hours span (approx) for first day only
      const coreStartRow = await db.get('SELECT value FROM settings WHERE key=?',[ 'core_start_hour' ]);
      const coreEndRow = await db.get('SELECT value FROM settings WHERE key=?',[ 'core_end_hour' ]);
      const coreStart = Number(coreStartRow?.value || 8);
      const coreEnd = Number(coreEndRow?.value || 16);
      const startDateObj = new Date(date);
      const startHour = isNaN(startDateObj.getTime()) ? coreStart : startDateObj.getHours();
      const perInstallerHours = Number(man_hours) / installers.length;
      const hoursSpan = [];
      // Collect each whole hour touched on the start day only
      for(let h=0; h < perInstallerHours && (startHour + h) < 24; h++) {
        hoursSpan.push(startHour + h);
      }
      for (const instId of installers) {
        const instAvail = (availability[instId]||{})[dayStr];
        if (!instAvail) continue; // no record => available
        if (instAvail.out) {
          return res.status(400).json({ error: 'Installer unavailable (out all day). Use availability override to allow.' });
        }
        if (Array.isArray(instAvail.outHours)) {
          const conflict = hoursSpan.some(h => instAvail.outHours.includes(h));
          if (conflict) {
            return res.status(400).json({ error: 'Installer unavailable (hour conflict). Use availability override to allow.' });
          }
        }
      }
    }
    // Slice generation helper (mirrors frontend logic sans travel deductions) -----------------
    async function generateSlices(startISO, totalManHours, installerIds, coreOverrideFlag) {
      const slices = [];
      if (!installerIds?.length || !totalManHours) return slices;
      const nInstallers = installerIds.length;
      const perClockTotal = Number(totalManHours) / nInstallers; // elapsed work (not including travel) hours per installer
      // Load core hours & holidays & drive settings
      const coreStartRow = await db.get('SELECT value FROM settings WHERE key=?',[ 'core_start_hour' ]);
      const coreEndRow = await db.get('SELECT value FROM settings WHERE key=?',[ 'core_end_hour' ]);
      const driveOutRow = await db.get('SELECT value FROM settings WHERE key=?',[ 'drive_out_minutes' ]);
      const driveReturnRow = await db.get('SELECT value FROM settings WHERE key=?',[ 'drive_return_minutes' ]);
      const driveOut = Number(driveOutRow?.value || 0);
      const driveBack = Number(driveReturnRow?.value || 0);
      const coreStart = Number(coreStartRow?.value || 8);
      const coreEnd = Number(coreEndRow?.value || 16);
      const coreSpan = coreEnd - coreStart;
      const holidaysRow = await db.get('SELECT value FROM settings WHERE key=?',['holidays']);
      let holidays = [];
      if (holidaysRow?.value) { try { holidays = JSON.parse(holidaysRow.value); } catch { holidays = []; } }
      if (!coreOverrideFlag && !override) {
        // Validate that at least some working time remains each day
        if (coreSpan - (driveOut/60) - (driveBack/60) <= 0) {
          throw new Error('No working time available inside core hours after reserving drive time. Adjust drive or core settings.');
        }
      }
      if (coreOverrideFlag || override) {
        // Travel can extend outside core hours; just single slice
        slices.push({ start: startISO, hours: perClockTotal });
        return slices;
      }
      let remaining = perClockTotal;
      let idx = 0;
      let cursor = new Date(startISO);
      if (isNaN(cursor.getTime())) cursor = new Date();
      // Align start to core start if earlier
      if (cursor.getHours() < coreStart) cursor.setHours(coreStart,0,0,0);
      while (remaining > 0 && idx < 100) {
        const dayKey = cursor.toISOString().slice(0,10);
        const isWeekend = cursor.getDay()===0 || cursor.getDay()===6 || holidays.includes(dayKey);
        // Weekend work without override should have been shifted earlier; if still encountered, skip day
        if (isWeekend) { cursor.setDate(cursor.getDate()+1); cursor.setHours(coreStart,0,0,0); idx++; continue; }
        const dayStart = new Date(cursor); dayStart.setHours(coreStart,0,0,0);
        const dayEnd = new Date(cursor); dayEnd.setHours(coreEnd,0,0,0);
        // Reserve travel inside core hours
        const workStart = new Date(dayStart.getTime() + driveOut*60000);
        const workEndCap = new Date(dayEnd.getTime() - driveBack*60000);
        if (workEndCap <= workStart) { cursor.setDate(cursor.getDate()+1); cursor.setHours(coreStart,0,0,0); idx++; continue; }
        // If first day and requested startISO is later than workStart, shift workStart forward (but keep travel within core)
        if (idx === 0) {
          const desired = new Date(startISO);
            if (!isNaN(desired.getTime()) && desired > workStart && desired < workEndCap) {
              // Ensure there is still room for return travel: end must allow driveBack to finish by coreEnd
              workStart.setTime(desired.getTime());
            }
        }
        const workCapHours = (workEndCap - workStart)/3600000;
        if (workCapHours <= 0) { cursor.setDate(cursor.getDate()+1); cursor.setHours(coreStart,0,0,0); idx++; continue; }
        const sliceHours = Math.min(remaining, workCapHours);
        slices.push({ start: workStart.toISOString(), hours: sliceHours });
        remaining -= sliceHours;
        cursor = new Date(dayStart); cursor.setDate(cursor.getDate()+1); cursor.setHours(coreStart,0,0,0);
        idx++;
      }
      return slices;
    }
    // Build provisional slices for validation (per-installer clock hours), regardless of override for availability & overlap if NOT override_hours
    const provisionalSlices = await generateSlices(date, man_hours, installers, core_hours_override);

    // Per-day 8h limit & overlap using existing persisted slices (schedule_slices) ----------------
    if (Array.isArray(installers) && installers.length && man_hours && !override) {
      for (const slice of provisionalSlices) {
        const sliceDay = slice.start.slice(0,10);
        const sliceStartTs = Date.parse(slice.start);
        const sliceEndTs = sliceStartTs + slice.hours*3600000;
        for (const installer_id of installers) {
          // Sum existing assigned per-installer clock hours on that day
          const existingDaySlices = await db.all(`
            SELECT ss.start_slice AS start, ss.duration_hours AS hours, s.id as schedule_id
            FROM (
              SELECT id, schedule_id, date as start_slice, duration_hours FROM schedule_slices
            ) ss
            JOIN schedules s ON s.id = ss.schedule_id
            JOIN schedule_installers si ON si.schedule_id = s.id
            WHERE si.installer_id = ? AND ss.start_slice LIKE ?
          `, [installer_id, `${sliceDay}%`]);
          let assignedClock = 0;
          for (const row of existingDaySlices) {
            assignedClock += Number(row.hours)||0;
            // Overlap check: existing slice window vs new slice window
            const otherStart = Date.parse(row.start);
            const otherEnd = otherStart + (Number(row.hours)||0)*3600000;
            const overlaps = otherStart < sliceEndTs && sliceStartTs < otherEnd;
            if (overlaps) {
              return res.status(400).json({ error: 'Time overlap detected for installer (multi-day spill). Use override to allow.' });
            }
          }
          if (assignedClock + slice.hours > 8.0001) {
            return res.status(400).json({ error: 'Installer would exceed 8 hours on a spillover day. Use override to allow.' });
          }
        }
      }
    }
    const result = await db.run(
      'INSERT INTO schedules (job_number, title, date, start_time, end_time, description, man_hours, core_hours_override, override_hours, override_availability, address) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [job_number, title, date, start_time, end_time, description, man_hours, core_hours_override?1:0, override?1:0, override_availability?1:0, req.body.address || null]
    );
    const schedule_id = result.lastID;
    if (Array.isArray(installers)) {
      for (const installer_id of installers) {
        await db.run('INSERT INTO schedule_installers (schedule_id, installer_id) VALUES (?, ?)', [schedule_id, installer_id]);
      }
    }
    // Persist slices
    for (let i=0;i<provisionalSlices.length;i++) {
      const sl = provisionalSlices[i];
      await db.run('INSERT INTO schedule_slices (schedule_id, slice_index, date, duration_hours) VALUES (?,?,?,?)', [schedule_id, i, sl.start, sl.hours]);
    }
  res.json({ id: schedule_id, job_number, title, date, start_time, end_time, description, installers, man_hours, core_hours_override: !!core_hours_override, override_hours: !!override, override_availability: !!override_availability, shiftedWeekend, shiftedHoliday, original_date: (shiftedWeekend||shiftedHoliday) ? original_date : undefined, rule_overrides });
  } catch (e) {
    if (e && /UNIQUE constraint failed: schedules\.job_number/.test(e.message || '')) {
      return res.status(409).json({ error: 'Job number already exists. Choose a different Job # or edit the existing job.' });
    }
    res.status(400).json({ error: e.message });
  }
});
// PATCH endpoint to update description, man_hours, installers, address, etc.
app.patch('/api/schedules/:id', async (req, res) => {
  let { description, man_hours, date, start_time, end_time, installers, address, override, core_hours_override, override_availability } = req.body;
  const rule_overrides = [];
  if (override) rule_overrides.push('hours_or_overlap');
  if (override_availability) rule_overrides.push('availability');
  if (core_hours_override) rule_overrides.push('core_hours');
  const { id } = req.params;
  try {
    // Weekend handling on update: auto-shift to next Monday if setting to weekend and no override flags
    let original_date = date;
  let shiftedWeekend = false;
  let shiftedHoliday = false;
    if (date) {
      const d = new Date(date);
      if (!isNaN(d.getTime())) {
        const dow = d.getDay();
        const holidaysRow = await db.get('SELECT value FROM settings WHERE key=?',['holidays']);
        let holidays = [];
        if (holidaysRow?.value) { try { holidays = JSON.parse(holidaysRow.value); } catch { holidays = []; } }
        const dateStr = d.toISOString().slice(0,10);
        const isHoliday = holidays.includes(dateStr);
        if (((dow === 0 || dow === 6) || isHoliday) && !override && !core_hours_override) {
          while (true) {
            const dow2 = d.getDay();
            const ds = d.toISOString().slice(0,10);
            const holidayNow = holidays.includes(ds);
            if (dow2 !== 0 && dow2 !== 6 && !holidayNow) break;
            d.setDate(d.getDate() + 1);
          }
            date = d.toISOString().slice(0,16);
            if (dow === 0 || dow === 6) shiftedWeekend = true; else shiftedHoliday = true;
        }
      }
    }
    // Availability enforcement on update unless overridden
    if (Array.isArray(installers) && installers.length && man_hours && !(override || override_availability)) {
      // Determine date
      let effDate = date;
      if (!effDate) {
        const job = await db.get('SELECT date FROM schedules WHERE id = ?', [id]);
        effDate = job?.date;
      }
      if (effDate) {
        const availabilityRow = await db.get('SELECT value FROM settings WHERE key=?',[ 'availability' ]);
        let availability = {};
        if (availabilityRow?.value) { try { availability = JSON.parse(availabilityRow.value); } catch { availability = {}; } }
        const dayStr = effDate.slice(0,10);
        const coreStartRow = await db.get('SELECT value FROM settings WHERE key=?',[ 'core_start_hour' ]);
        const coreStart = Number(coreStartRow?.value || 8);
        const startDateObj = new Date(effDate);
        const startHour = isNaN(startDateObj.getTime()) ? coreStart : startDateObj.getHours();
        const perInstallerHours = Number(man_hours) / installers.length;
        const hoursSpan = [];
        for(let h=0; h < perInstallerHours && (startHour + h) < 24; h++) hoursSpan.push(startHour + h);
        for (const instId of installers) {
          const instAvail = (availability[instId]||{})[dayStr];
          if (!instAvail) continue;
          if (instAvail.out) {
            return res.status(400).json({ error: 'Installer unavailable (out all day). Use availability override to allow.' });
          }
          if (Array.isArray(instAvail.outHours)) {
            const conflict = hoursSpan.some(h => instAvail.outHours.includes(h));
            if (conflict) {
              return res.status(400).json({ error: 'Installer unavailable (hour conflict). Use availability override to allow.' });
            }
          }
        }
      }
    }
    // Enforce 8-hour limit per installer per day unless override
    // Re-slice & validate (multi-day spillover) --------------------------------------------------
    async function generateSlices(startISO, totalManHours, installerIds, coreOverrideFlag) {
      const slices = [];
      if (!installerIds?.length || !totalManHours) return slices;
      const nInstallers = installerIds.length;
      const perClockTotal = Number(totalManHours) / nInstallers;
      const coreStartRow = await db.get('SELECT value FROM settings WHERE key=?',[ 'core_start_hour' ]);
      const coreEndRow = await db.get('SELECT value FROM settings WHERE key=?',[ 'core_end_hour' ]);
      const driveOutRow = await db.get('SELECT value FROM settings WHERE key=?',[ 'drive_out_minutes' ]);
      const driveReturnRow = await db.get('SELECT value FROM settings WHERE key=?',[ 'drive_return_minutes' ]);
      const driveOut = Number(driveOutRow?.value || 0);
      const driveBack = Number(driveReturnRow?.value || 0);
      const coreStart = Number(coreStartRow?.value || 8);
      const coreEnd = Number(coreEndRow?.value || 16);
      const coreSpan = coreEnd - coreStart;
      const holidaysRow = await db.get('SELECT value FROM settings WHERE key=?',['holidays']);
      let holidays = [];
      if (holidaysRow?.value) { try { holidays = JSON.parse(holidaysRow.value); } catch { holidays = []; } }
      if (!coreOverrideFlag && !override) {
        if (coreSpan - (driveOut/60) - (driveBack/60) <= 0) throw new Error('No working time after reserving drive time. Adjust settings.');
      }
      if (coreOverrideFlag || override) {
        slices.push({ start: startISO, hours: perClockTotal });
        return slices;
      }
      let remaining = perClockTotal;
      let idx = 0; let cursor = new Date(startISO); if (isNaN(cursor.getTime())) cursor = new Date(); if (cursor.getHours() < coreStart) cursor.setHours(coreStart,0,0,0);
      while (remaining > 0 && idx < 100) {
        const dayKey = cursor.toISOString().slice(0,10);
        const isWeekend = cursor.getDay()===0 || cursor.getDay()===6 || holidays.includes(dayKey);
        if (isWeekend) { cursor.setDate(cursor.getDate()+1); cursor.setHours(coreStart,0,0,0); idx++; continue; }
        const dayStart = new Date(cursor); dayStart.setHours(coreStart,0,0,0);
        const dayEnd = new Date(cursor); dayEnd.setHours(coreEnd,0,0,0);
        const workStart = new Date(dayStart.getTime() + driveOut*60000);
        const workEndCap = new Date(dayEnd.getTime() - driveBack*60000);
        if (workEndCap <= workStart) { cursor.setDate(cursor.getDate()+1); cursor.setHours(coreStart,0,0,0); idx++; continue; }
        if (idx === 0) {
          const desired = new Date(startISO); if (!isNaN(desired.getTime()) && desired > workStart && desired < workEndCap) workStart.setTime(desired.getTime());
        }
        const workCapHours = (workEndCap - workStart)/3600000; if (workCapHours <= 0) { cursor.setDate(cursor.getDate()+1); cursor.setHours(coreStart,0,0,0); idx++; continue; }
        const sliceHours = Math.min(remaining, workCapHours);
        slices.push({ start: workStart.toISOString(), hours: sliceHours });
        remaining -= sliceHours; cursor = new Date(dayStart); cursor.setDate(cursor.getDate()+1); cursor.setHours(coreStart,0,0,0); idx++;
      }
      return slices;
    }
    // Determine effective date for update
    let effectiveDate = date;
    if (!effectiveDate) {
      const job = await db.get('SELECT date FROM schedules WHERE id = ?', [id]);
      effectiveDate = job?.date;
    }
    const provisionalSlices = await generateSlices(effectiveDate, man_hours, installers, core_hours_override);
    if (Array.isArray(installers) && installers.length && man_hours && !override) {
      for (const slice of provisionalSlices) {
        const sliceDay = slice.start.slice(0,10);
        const sliceStartTs = Date.parse(slice.start);
        const sliceEndTs = sliceStartTs + slice.hours*3600000;
        for (const installer_id of installers) {
          const existingDaySlices = await db.all(`
            SELECT ss.id, ss.date as start, ss.duration_hours AS hours, s.id as schedule_id
            FROM schedule_slices ss
            JOIN schedules s ON s.id = ss.schedule_id
            JOIN schedule_installers si ON si.schedule_id = s.id
            WHERE si.installer_id = ? AND ss.date LIKE ?
          `, [installer_id, `${sliceDay}%`]);
          let assignedClock = 0;
            for (const row of existingDaySlices) {
              if (row.schedule_id == id) continue; // skip self
              assignedClock += Number(row.hours)||0;
              const otherStart = Date.parse(row.start);
              const otherEnd = otherStart + (Number(row.hours)||0)*3600000;
              const overlaps = otherStart < sliceEndTs && sliceStartTs < otherEnd;
              if (overlaps) {
                return res.status(400).json({ error: 'Time overlap detected for installer (update spill). Use override to allow.' });
              }
            }
          if (assignedClock + slice.hours > 8.0001) {
            return res.status(400).json({ error: 'Installer would exceed 8 hours on a spillover day (update). Use override to allow.' });
          }
        }
      }
    }
    // Build update query
    const updates = [];
    const params = [];
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (man_hours !== undefined) { updates.push('man_hours = ?'); params.push(man_hours); }
    if (date !== undefined) { updates.push('date = ?'); params.push(date); }
    if (start_time !== undefined) { updates.push('start_time = ?'); params.push(start_time); }
    if (end_time !== undefined) { updates.push('end_time = ?'); params.push(end_time); }
    if (address !== undefined) { updates.push('address = ?'); params.push(address); }
    if (override !== undefined) { updates.push('override_hours = ?'); params.push(override?1:0); }
    if (override_availability !== undefined) { updates.push('override_availability = ?'); params.push(override_availability?1:0); }
    if (core_hours_override !== undefined) { updates.push('core_hours_override = ?'); params.push(core_hours_override?1:0); }
    if (updates.length) {
      await db.run(`UPDATE schedules SET ${updates.join(', ')} WHERE id = ?`, [...params, id]);
    }
    // Update installers
    if (Array.isArray(installers)) {
      await db.run('DELETE FROM schedule_installers WHERE schedule_id = ?', [id]);
      for (const installer_id of installers) {
        await db.run('INSERT INTO schedule_installers (schedule_id, installer_id) VALUES (?, ?)', [id, installer_id]);
      }
    }
    // Rebuild slices if man_hours / date / installers / override flags changed
    if (provisionalSlices.length) {
      await db.run('DELETE FROM schedule_slices WHERE schedule_id = ?', [id]);
      for (let i=0;i<provisionalSlices.length;i++) {
        const sl = provisionalSlices[i];
        await db.run('INSERT INTO schedule_slices (schedule_id, slice_index, date, duration_hours) VALUES (?,?,?,?)', [id, i, sl.start, sl.hours]);
      }
    }
    const updated = await db.get('SELECT * FROM schedules WHERE id = ?', [id]);
    const updatedInstallers = await db.all('SELECT installer_id FROM schedule_installers WHERE schedule_id = ?', [id]);
    updated.installers = updatedInstallers.map(i => i.installer_id);
  res.json({ ...updated, shiftedWeekend, shiftedHoliday, original_date: (shiftedWeekend||shiftedHoliday) ? original_date : undefined, rule_overrides });
  } catch (e) {
    if (e && /UNIQUE constraint failed: schedules\.job_number/.test(e.message || '')) {
      return res.status(409).json({ error: 'Job number already exists. Use a different Job #.' });
    }
    res.status(400).json({ error: e.message });
  }
});

// Delete schedule (and its installer links)
app.delete('/api/schedules/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.run('DELETE FROM schedule_installers WHERE schedule_id = ?', [id]);
    await db.run('DELETE FROM schedules WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Installers routes
app.get('/api/installers', async (req, res) => {
  const installers = await db.all('SELECT * FROM installers');
  res.json(installers);
});

app.post('/api/installers', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const result = await db.run('INSERT INTO installers (name, email) VALUES (?, ?)', [name, email || null]);
    res.json({ id: result.lastID, name, email: email || null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Edit installer
app.patch('/api/installers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email } = req.body;
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (email !== undefined) { updates.push('email = ?'); params.push(email || null); }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    await db.run(`UPDATE installers SET ${updates.join(', ')} WHERE id = ?`, [...params, id]);
    const row = await db.get('SELECT * FROM installers WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Delete installer
app.delete('/api/installers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.run('DELETE FROM installers WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// XLSX import route
// Import Pace Jobs (XLSX) - enrichment only: DO NOT create new schedules; update matching install_request jobs
app.post('/api/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const workbook = XLSX.readFile(req.file.path);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const jobs = XLSX.utils.sheet_to_json(sheet);
  let enriched = 0; // rows that updated an existing job
  let unmatched = 0; // rows with no existing job to enrich
  for (const job of jobs) {
    // Map spreadsheet fields to DB fields
    const job_number = job['Job'] || job['Job Number'] || '';
    const title = job['Name'] || job['Title'] || '';
    const date = job['Promise Date'] || job['Date Setup'] || job['Date'] || '';
    const description = job['Description'] || '';
    const man_hours = job['Man Hours'] || job['Estimated Man-Hours'] || job['Estimated Man Hours'] || null;
    // Concatenate address fields in order
    const addressParts = [
      job['Add. Line 1'],
      job['Add. Line 2'],
      job['Add. Line 3'],
      job['Alt Add. Line 1'],
      job['Alt Add. Line 2'],
      job['Alt Add. Line 3'],
      job['Zip'],
      job['State']
    ];
    const address = addressParts.filter(Boolean).join(', ');
    if (!job_number || !title || !date) continue;
    try {
      // Find existing schedule (prefer install_request origin)
      const existing = await db.get('SELECT id, source_type FROM schedules WHERE job_number = ?', [job_number]);
      if (!existing) { unmatched++; continue; }
      // Enrich pace_* columns; do not overwrite core install_request fields
      await db.run('UPDATE schedules SET pace_title = ?, pace_date = ?, pace_description = ?, pace_man_hours = ?, pace_address = ? WHERE id = ?', [title, date, description, man_hours, address, existing.id]);
      enriched++;
    } catch { unmatched++; }
  }
  res.json({ enriched, unmatched });
});

// Import Install Request Forms (CSV) with headers:
// "WO#","Production Completion Date","Customer Name","Building Name","On-Site Contact","On-Site Contact Number","Salesperson","Project Manager","Project Manager's Phone","Install Address","Street Address","City","State/Region/Province","Postal / Zip Code","Notes","File Upload"
app.post('/api/import/install-requests', upload.single('file'), async (req,res)=>{
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const fs = await import('fs');
    const raw = fs.readFileSync(req.file.path, 'utf8');
    const lines = raw.split(/\r?\n/).filter(l=>l.trim().length>0);
    if (!lines.length) return res.status(400).json({ error: 'Empty CSV' });
    // Basic CSV parser supporting quotes
    function parseLine(line){
      const out=[]; let cur=''; let inQ=false; for (let i=0;i<line.length;i++){ const ch=line[i]; if (ch==='"'){ if (inQ && line[i+1]==='"'){ cur+='"'; i++; } else inQ=!inQ; } else if (ch===',' && !inQ){ out.push(cur.trim()); cur=''; } else { cur+=ch; } } out.push(cur.trim()); return out; }
    const header = parseLine(lines[0]).map(h=>h.replace(/^\ufeff/,''));
    const idx = (name) => header.findIndex(h=>h.toLowerCase()===name.toLowerCase());
    const colMap = {
      wo: idx('WO#'),
      prodDate: idx('Production Completion Date'),
      customer: idx('Customer Name'),
      building: idx('Building Name'),
      onsiteContact: idx('On-Site Contact'),
      onsitePhone: idx('On-Site Contact Number'),
      salesperson: idx('Salesperson'),
      pm: idx('Project Manager'),
      pmPhone: idx("Project Manager's Phone"),
      installAddress: idx('Install Address'),
      street: idx('Street Address'),
      city: idx('City'),
      state: idx('State/Region/Province'),
      zip: idx('Postal / Zip Code'),
      notes: idx('Notes'),
      fileUpload: idx('File Upload')
    };
    let imported=0, duplicates=0, errors=0; const rows=[];
    for (let li=1; li<lines.length; li++) {
      const parts = parseLine(lines[li]); if (!parts.length) continue;
      const job_number = colMap.wo>=0 ? parts[colMap.wo] : '';
      if (!job_number) { errors++; continue; }
      const prodDate = colMap.prodDate>=0 ? parts[colMap.prodDate] : '';
      const date = prodDate ? new Date(prodDate).toISOString().slice(0,16) : new Date().toISOString().slice(0,16);
      const customer_name = colMap.customer>=0 ? parts[colMap.customer] : '';
      const building_name = colMap.building>=0 ? parts[colMap.building] : '';
      const onsiteContactRaw = colMap.onsiteContact>=0 ? parts[colMap.onsiteContact] : '';
      let onsite_first='', onsite_last='';
      if (onsiteContactRaw) {
        const seg = onsiteContactRaw.replace(/,/g,' ').trim().split(/\s+/);
        onsite_first = seg[0]||''; onsite_last = seg.slice(1).join(' ');
      }
      const onsite_contact_phone = colMap.onsitePhone>=0 ? parts[colMap.onsitePhone] : '';
      const salesperson = colMap.salesperson>=0 ? parts[colMap.salesperson] : '';
      const project_manager = colMap.pm>=0 ? parts[colMap.pm] : '';
      const project_manager_phone = colMap.pmPhone>=0 ? parts[colMap.pmPhone] : '';
      const addrPieces = [];
      const installAddr = colMap.installAddress>=0 ? parts[colMap.installAddress] : '';
      if (installAddr) addrPieces.push(installAddr);
      const street = colMap.street>=0 ? parts[colMap.street] : '';
      const city = colMap.city>=0 ? parts[colMap.city] : '';
      const state = colMap.state>=0 ? parts[colMap.state] : '';
      const zip = colMap.zip>=0 ? parts[colMap.zip] : '';
      if (street) addrPieces.push(street);
      const cityLine = [city,state,zip].filter(Boolean).join(', ');
      if (cityLine) addrPieces.push(cityLine);
      const address = addrPieces.filter(Boolean).join(', ');
      const notes = colMap.notes>=0 ? parts[colMap.notes] : '';
      const file_ref = colMap.fileUpload>=0 ? parts[colMap.fileUpload] : '';
      try {
        let result;
        // If already scheduled, upgrade existing; else create pending job (no schedule yet)
        const existing = await db.get('SELECT id FROM schedules WHERE job_number = ?', [job_number]);
        if (existing) {
          await db.run('UPDATE schedules SET title = ?, description = ?, address = ?, source_type = ?, customer_name = ?, building_name = ?, onsite_contact_first = ?, onsite_contact_last = ?, onsite_contact_phone = ?, salesperson = ?, project_manager = ?, project_manager_phone = ?, notes = ?, file_ref = ? WHERE id = ?', [customer_name || building_name || job_number, building_name, address, 'install_request', customer_name, building_name, onsite_first, onsite_last, onsite_contact_phone, salesperson, project_manager, project_manager_phone, notes, file_ref, existing.id]);
          duplicates++;
        } else {
          // Insert into pending_jobs (ignore duplicates quietly)
          try {
            await db.run('INSERT OR IGNORE INTO pending_jobs (job_number, title, description, address, source_type, customer_name, building_name, onsite_contact_first, onsite_contact_last, onsite_contact_phone, salesperson, project_manager, project_manager_phone, notes, file_ref, man_hours) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [job_number, customer_name || building_name || job_number, building_name, address, 'install_request', customer_name, building_name, onsite_first, onsite_last, onsite_contact_phone, salesperson, project_manager, project_manager_phone, notes, file_ref, null]);
            imported++;
          } catch { errors++; }
        }
      } catch (err) {
        errors++;
      }
    }
    res.json({ imported, duplicates, errors });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// List pending jobs
app.get('/api/pending-jobs', async (req,res)=>{
  try {
    const rows = await db.all('SELECT * FROM pending_jobs ORDER BY created_at DESC');
    res.json(rows);
  } catch(e){ res.status(500).json({ error: e.message }); }
});

// Create a pending job manually (manual entry form now stages instead of scheduling directly)
app.post('/api/pending-jobs', async (req,res)=>{
  try {
  const { job_number, title, description, address, customer_name, building_name, onsite_contact_first, onsite_contact_last, onsite_contact_phone, salesperson, project_manager, project_manager_phone, notes, file_ref, man_hours } = req.body || {};
    if (!job_number) return res.status(400).json({ error: 'job_number required' });
    // If already exists as scheduled, reject (user should edit existing)
    const existingSched = await db.get('SELECT id FROM schedules WHERE job_number = ?', [job_number]);
    if (existingSched) return res.status(409).json({ error: 'Job number already scheduled' });
    // If already in pending, return that (idempotent)
    const existingPending = await db.get('SELECT * FROM pending_jobs WHERE job_number = ?', [job_number]);
    if (existingPending) return res.status(200).json(existingPending);
  const stmt = await db.run('INSERT INTO pending_jobs (job_number, title, description, address, source_type, customer_name, building_name, onsite_contact_first, onsite_contact_last, onsite_contact_phone, salesperson, project_manager, project_manager_phone, notes, file_ref, man_hours) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [job_number, title || description || job_number, description, address, 'manual', customer_name, building_name, onsite_contact_first, onsite_contact_last, onsite_contact_phone, salesperson, project_manager, project_manager_phone, notes, file_ref, man_hours || null]);
    const created = await db.get('SELECT * FROM pending_jobs WHERE id = ?', [stmt.lastID]);
    res.status(201).json(created);
  } catch(e){
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Job number already pending' });
    res.status(400).json({ error: e.message });
  }
});

// Schedule a pending job (promote to schedules)
app.post('/api/pending-jobs/:id/schedule', async (req,res)=>{
  try {
    const { id } = req.params;
    const { date, man_hours } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date required' });
    const pj = await db.get('SELECT * FROM pending_jobs WHERE id = ?', [id]);
    if (!pj) return res.status(404).json({ error: 'Pending job not found' });
    // Insert into schedules (basic, no installers yet)
  const mh = (man_hours != null) ? man_hours : (pj.man_hours != null ? pj.man_hours : 0);
  const result = await db.run('INSERT INTO schedules (job_number, title, date, description, man_hours, address, source_type, customer_name, building_name, onsite_contact_first, onsite_contact_last, onsite_contact_phone, salesperson, project_manager, project_manager_phone, notes, file_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [pj.job_number, pj.title, date, pj.description, mh, pj.address, pj.source_type, pj.customer_name, pj.building_name, pj.onsite_contact_first, pj.onsite_contact_last, pj.onsite_contact_phone, pj.salesperson, pj.project_manager, pj.project_manager_phone, pj.notes, pj.file_ref]);
    // Remove from pending
    await db.run('DELETE FROM pending_jobs WHERE id = ?', [id]);
    // Build initial slices (reuse slice generation from earlier function maybe minimal: single slice if man_hours provided)
    // For now, rely on front-end edits to adjust man_hours/installers later.
    res.json({ scheduled_id: result.lastID });
  } catch(e){ res.status(400).json({ error: e.message }); }
});

app.listen(port, () => {
  console.log(`Backend API listening on port ${port}`);
});

// Calendar update email endpoint
app.post('/api/send-calendar-updates', async (req, res) => {
  try {
    const { fromDate, toDate } = req.body || {};
    const start = fromDate ? new Date(fromDate) : new Date();
    const end = toDate ? new Date(toDate) : new Date(start.getTime() + 14*24*3600000);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return res.status(400).json({ error: 'Invalid date range' });
    // Normalize range to ISO for comparison
    const startISO = start.toISOString();
    const endISO = end.toISOString();
    // Fetch schedules and their installers
    const schedules = await db.all('SELECT * FROM schedules WHERE date BETWEEN ? AND ?', [startISO, endISO]);
    if (!schedules.length) return res.json({ success:true, results: [] });
    const assignments = await db.all('SELECT schedule_id, installer_id FROM schedule_installers');
    const installers = await db.all('SELECT * FROM installers');
    const installerMap = Object.fromEntries(installers.map(i=>[i.id, i]));
    // map schedule to its installers list for per-inst duration calc
    const scheduleInstallersMap = {};
    assignments.forEach(a => { if (!scheduleInstallersMap[a.schedule_id]) scheduleInstallersMap[a.schedule_id] = []; scheduleInstallersMap[a.schedule_id].push(a.installer_id); });
    // Build per installer job list
    const byInstaller = {};
    schedules.forEach(s => {
      const insts = scheduleInstallersMap[s.id] || [];
      insts.forEach(id => { if (!byInstaller[id]) byInstaller[id] = []; byInstaller[id].push({ ...s, installers: insts }); });
    });
    function formatDateICS(dt) { const d = new Date(dt); return d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z'); }
    // Ensure UID & sequence stored per schedule+installer
    async function getOrCreateUid(schedule_id, installer_id) {
      let row = await db.get('SELECT uid, sequence FROM calendar_events_sent WHERE schedule_id = ? AND installer_id = ?', [schedule_id, installer_id]);
      if (!row) {
        const uid = `job-${schedule_id}-${installer_id}@install-scheduler`; // deterministic
        await db.run('INSERT INTO calendar_events_sent (schedule_id, installer_id, uid, sequence, last_sent) VALUES (?,?,?,?,?)', [schedule_id, installer_id, uid, 0, new Date().toISOString()]);
        row = { uid, sequence: 0 };
      }
      return row;
    }
    async function bumpSequence(schedule_id, installer_id) {
      await db.run('UPDATE calendar_events_sent SET sequence = sequence + 1, last_sent = ? WHERE schedule_id = ? AND installer_id = ?', [new Date().toISOString(), schedule_id, installer_id]);
      const row = await db.get('SELECT uid, sequence FROM calendar_events_sent WHERE schedule_id = ? AND installer_id = ?', [schedule_id, installer_id]);
      return row;
    }
    function icsForInstaller(installer, jobs, uidSeqMap) {
      const lines = [
        'BEGIN:VCALENDAR',
        'PRODID:-//Install Scheduling App//EN',
        'VERSION:2.0',
        'CALSCALE:GREGORIAN',
        'METHOD:REQUEST'
      ];
      jobs.forEach(job => {
        const start = job.date;
        const manHours = Number(job.man_hours) || 0;
        const perInst = manHours / ((Array.isArray(job.installers) && job.installers.length) ? job.installers.length : 1);
        const startDate = new Date(start);
        const endDate = new Date(startDate.getTime() + perInst * 3600000);
        const { uid, sequence } = uidSeqMap[job.id];
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:${uid}`);
        lines.push(`SEQUENCE:${sequence}`);
        lines.push(`DTSTAMP:${formatDateICS(new Date())}`);
        lines.push(`DTSTART:${formatDateICS(startDate)}`);
        lines.push(`DTEND:${formatDateICS(endDate)}`);
        lines.push(`SUMMARY:${(job.job_number||'') + ' ' + (job.description||'Job')}`.trim());
        if (job.address) lines.push(`LOCATION:${job.address.replace(/\n/g,' ')}`);
        lines.push('END:VEVENT');
      });
      lines.push('END:VCALENDAR');
      return lines.join('\r\n');
    }
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.example.com',
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined
    });
    const results = [];
    for (const [installerId, jobs] of Object.entries(byInstaller)) {
      const installer = installerMap[installerId];
      if (!installer || !installer.email) continue;
      // Prepare uid/sequence map and bump sequence for this send
      const uidSeqMap = {};
      for (const job of jobs) {
        await getOrCreateUid(job.id, installerId);
        const row = await bumpSequence(job.id, installerId);
        uidSeqMap[job.id] = row; // include updated sequence
      }
      const ics = icsForInstaller(installer, jobs, uidSeqMap);
      try {
        await transporter.sendMail({
          from: process.env.MAIL_FROM || 'no-reply@example.com',
          to: installer.email,
          subject: 'Schedule Updates',
          text: 'Your schedule has been updated. Import the attached calendar file.',
          attachments: [{ filename: 'schedule.ics', content: ics, contentType: 'text/calendar; charset=utf-8; method=REQUEST' }]
        });
        results.push({ installer: installer.email, status: 'sent', count: jobs.length });
      } catch (e) {
        results.push({ installer: installer.email, status: 'error', error: e.message });
      }
    }
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Utility: geocode with caching
async function geocodeAddressCached(address) {
  if (!address) throw new Error('Missing address');
  const original = address;
  address = address.replace(/\s+/g,' ').trim();
  const cached = await db.get('SELECT lon, lat FROM geocode_cache WHERE address = ?', [address]);
  if (cached) return [cached.lon, cached.lat];
  if (!ORS_API_KEY || ORS_API_KEY === 'REPLACE_ME') throw new Error('ORS API key not configured');
  const url = `https://api.openrouteservice.org/geocode/search?api_key=${ORS_API_KEY}&text=${encodeURIComponent(address)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Geocoding failed');
  const data = await resp.json();
  const feat = data.features && data.features[0];
  if (!feat) {
    console.warn('[geocode] no result for', original, 'normalized as', address);
    throw new Error('No geocode result');
  }
  const [lon, lat] = feat.geometry.coordinates;
  await db.run('INSERT OR REPLACE INTO geocode_cache (address, lon, lat, fetched_at) VALUES (?,?,?,?)', [address, lon, lat, new Date().toISOString()]);
  console.log(`[geocode] ${address} -> (${lon},${lat})`);
  return [lon, lat];
}

// Driving time with caching (one-way minutes) using OpenRouteService
app.post('/api/driving-time', async (req, res) => {
  try {
    const { origin, destination, force } = req.body || {};
    if (!origin || !destination) return res.status(400).json({ error: 'origin and destination required' });
    function clean(addr){
      return addr
        .replace(/Ste\.?(\s+\w+)?/ig,'')
        .replace(/Suite\s+\w+/ig,'')
        .replace(/#\s*\w+/g,'')
        .replace(/\s+/g,' ')
        .replace(/\.$/,'')
        .trim();
    }
    let originUse = origin;
    let destUse = destination;
    let cached = !force && await db.get('SELECT minutes, distance FROM drive_time_cache WHERE origin = ? AND destination = ?', [originUse, destUse]);
    if (!cached && !force) {
      const reverse = await db.get('SELECT minutes, distance FROM drive_time_cache WHERE origin = ? AND destination = ?', [destUse, originUse]);
      if (reverse) cached = reverse;
    }
    if (cached) return res.json({ origin: originUse, destination: destUse, minutes: cached.minutes, distance_km: cached.distance, cached: true });
    console.log(`[drive-time] fetching fresh route ${originUse} -> ${destUse}`);
    let [oLon, oLat] = await geocodeAddressCached(originUse);
    let [dLon, dLat] = await geocodeAddressCached(destUse);
    if (!ORS_API_KEY || ORS_API_KEY === 'REPLACE_ME') return res.status(400).json({ error: 'ORS API key not configured' });
    async function fetchRoute(aLon,aLat,bLon,bLat,label){
      const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${ORS_API_KEY}&start=${aLon},${aLat}&end=${bLon},${bLat}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        const bodyTxt = await resp.text();
        throw new Error(`Routing failed (${label}) ${resp.status}: ${bodyTxt.slice(0,120)}`);
      }
      return resp.json();
    }
    let json = await fetchRoute(oLon,oLat,dLon,dLat,'original');
        function extractSummary(obj){
          if (!obj || typeof obj !== 'object') return null;
          if (obj.routes && obj.routes[0] && obj.routes[0].summary) return obj.routes[0].summary; // non-geojson variant
          if (obj.features && obj.features[0] && obj.features[0].properties) {
            const p = obj.features[0].properties;
            if (p.summary) return p.summary;
            // Some ORS responses only include segments (array) with distance/duration
            if (Array.isArray(p.segments) && p.segments[0] && (p.segments[0].distance!=null || p.segments[0].duration!=null)) {
              const dist = p.segments.reduce((acc,s)=>acc + (s.distance||0),0);
                const dur = p.segments.reduce((acc,s)=>acc + (s.duration||0),0);
              return { distance: dist, duration: dur };
            }
          }
          return null;
        }
        let summary = extractSummary(json);
        let seconds = summary?.duration;
        let meters = summary?.distance;
    if (!seconds) {
      console.warn('[drive-time] missing summary on GET result (original) snippet:', JSON.stringify(json).slice(0,200));
      const cleanedOrigin = clean(originUse);
      const cleanedDest = clean(destUse);
      if (cleanedOrigin !== originUse || cleanedDest !== destUse) {
        console.log('[drive-time] retry cleaned', cleanedOrigin, '->', cleanedDest);
        originUse = cleanedOrigin; destUse = cleanedDest;
        ;[oLon,oLat] = await geocodeAddressCached(originUse);
        ;[dLon,dLat] = await geocodeAddressCached(destUse);
        json = await fetchRoute(oLon,oLat,dLon,dLat,'cleaned');
        summary = extractSummary(json);
        seconds = summary?.duration;
        meters = summary?.distance;
      }
      if (!seconds) {
        console.warn('[drive-time] still missing summary after cleaned GET attempts; trying POST fallback');
        // POST fallback per ORS docs
        try {
          const postResp = await fetch('https://api.openrouteservice.org/v2/directions/driving-car', {
            method: 'POST',
            headers: { 'Authorization': ORS_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ coordinates: [[oLon,oLat],[dLon,dLat]] })
          });
          if (postResp.ok) {
            const postJson = await postResp.json();
            summary = extractSummary(postJson);
            seconds = summary?.duration;
            meters = summary?.distance;
            if (!seconds) console.warn('[drive-time] POST fallback also lacked summary snippet:', JSON.stringify(postJson).slice(0,200));
          } else {
            const txt = await postResp.text();
            console.warn('[drive-time] POST fallback HTTP error', postResp.status, txt.slice(0,160));
          }
        } catch (err) {
          console.warn('[drive-time] POST fallback exception', err.message);
        }
        if (!seconds) {
          // Haversine approximate fallback so UI can still show something
          const R = 6371; // km
          const toRad = d => d * Math.PI/180;
          const dLatRad = toRad(dLat - oLat);
          const dLonRad = toRad(dLon - oLon);
          const a = Math.sin(dLatRad/2)**2 + Math.cos(toRad(oLat))*Math.cos(toRad(dLat))*Math.sin(dLonRad/2)**2;
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
          const straightKm = +(R * c).toFixed(2);
          // assume avg speed 65 km/h (rough urban/suburban blend)
          const minutesApprox = Math.max(5, Math.round((straightKm / 65) * 60));
          console.warn('[drive-time] no route after all attempts, returning approximate haversine', straightKm,'km', minutesApprox,'min');
          await db.run('INSERT OR REPLACE INTO drive_time_cache (origin, destination, minutes, distance, fetched_at) VALUES (?,?,?,?,?)', [originUse, destUse, minutesApprox, straightKm, new Date().toISOString()]);
          return res.json({ origin: originUse, destination: destUse, minutes: minutesApprox, distance_km: straightKm, cached: false, approximate: true });
        }
      }
    }
    const minutes = Math.round(seconds / 60);
    const distanceKm = meters != null ? Number((meters/1000).toFixed(2)) : null;
    await db.run('INSERT OR REPLACE INTO drive_time_cache (origin, destination, minutes, distance, fetched_at) VALUES (?,?,?,?,?)', [originUse, destUse, minutes, distanceKm, new Date().toISOString()]);
    console.log(`[drive-time] stored ${originUse} -> ${destUse}: ${minutes}m, ${distanceKm}km`);
    res.json({ origin: originUse, destination: destUse, minutes, distance_km: distanceKm, cached: false });
  } catch (e) {
    console.error('[drive-time] error', e.message);
    res.status(400).json({ error: e.message });
  }
});

// Batch prefetch driving times for a list of jobs relative to a home base address.
// Body: { homeBase: string, addresses: [string], force?: boolean }
app.post('/api/driving-time/prefetch', async (req, res) => {
  try {
    const { homeBase, addresses, force } = req.body || {};
    if (!homeBase || !Array.isArray(addresses)) return res.status(400).json({ error: 'homeBase and addresses[] required' });
    const unique = [...new Set(addresses.filter(a => !!a && a.trim().length))];
    const results = [];
    const clean = a => a.replace(/Ste\.?(\s+\w+)?/ig,'').replace(/Suite\s+\w+/ig,'').replace(/#\s*\w+/g,'').replace(/\s+/g,' ').replace(/\.$/,'').trim();
    function extractSummary(obj){
      if (!obj || typeof obj !== 'object') return null;
      if (obj.routes && obj.routes[0] && obj.routes[0].summary) return obj.routes[0].summary;
      if (obj.features && obj.features[0] && obj.features[0].properties){
        const p = obj.features[0].properties;
        if (p.summary) return p.summary;
        if (Array.isArray(p.segments) && p.segments[0]){
          const dist = p.segments.reduce((acc,s)=>acc + (s.distance||0),0);
          const dur = p.segments.reduce((acc,s)=>acc + (s.duration||0),0);
          return { distance: dist, duration: dur };
        }
      }
      return null;
    }
    for (const addrOrig of unique) {
      let addr = addrOrig;
      try {
        let cached = !force && await db.get('SELECT minutes, distance FROM drive_time_cache WHERE origin = ? AND destination = ?', [homeBase, addr]);
        if (!cached && !force) {
          const reverse = await db.get('SELECT minutes, distance FROM drive_time_cache WHERE origin = ? AND destination = ?', [addr, homeBase]);
          if (reverse) cached = reverse;
        }
        if (cached) { results.push({ address: addrOrig, minutes: cached.minutes, distance_km: cached.distance, cached: true }); continue; }
        console.log(`[drive-time][prefetch] fetching ${homeBase} -> ${addr}`);
        let [oLon,oLat] = await geocodeAddressCached(homeBase);
        let [dLon,dLat] = await geocodeAddressCached(addr);
        if (!ORS_API_KEY || ORS_API_KEY === 'REPLACE_ME') throw new Error('ORS API key not configured');
        const baseUrl = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${ORS_API_KEY}&start=${oLon},${oLat}&end=${dLon},${dLat}`;
        let resp = await fetch(baseUrl);
        if (resp.status === 429) { await new Promise(r=>setTimeout(r,500)); resp = await fetch(baseUrl); }
        if (!resp.ok) throw new Error('Routing failed');
        let json = await resp.json();
        let summary = extractSummary(json);
        let seconds = summary?.duration; let meters = summary?.distance;
        if (!seconds) {
          const cleaned = clean(addr);
          if (cleaned !== addr) {
            addr = cleaned; console.log('[drive-time][prefetch] retry cleaned', addrOrig,'->', addr);
            [dLon,dLat] = await geocodeAddressCached(addr);
            const retryUrl = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${ORS_API_KEY}&start=${oLon},${oLat}&end=${dLon},${dLat}`;
            let r2 = await fetch(retryUrl); if (r2.status===429){ await new Promise(r=>setTimeout(r,500)); r2 = await fetch(retryUrl);} 
            if (r2.ok){
              json = await r2.json(); summary = extractSummary(json); seconds = summary?.duration; meters = summary?.distance;
            }
          }
        }
        if (!seconds) {
          // POST fallback
          try {
            let postResp = await fetch('https://api.openrouteservice.org/v2/directions/driving-car', { method:'POST', headers:{Authorization: ORS_API_KEY, 'Content-Type':'application/json'}, body: JSON.stringify({ coordinates:[[oLon,oLat],[dLon,dLat]] }) });
            if (postResp.status===429){ await new Promise(r=>setTimeout(r,800)); postResp = await fetch('https://api.openrouteservice.org/v2/directions/driving-car', { method:'POST', headers:{Authorization: ORS_API_KEY, 'Content-Type':'application/json'}, body: JSON.stringify({ coordinates:[[oLon,oLat],[dLon,dLat]] }) }); }
            if (postResp.ok){ const pj = await postResp.json(); summary = extractSummary(pj); seconds = summary?.duration; meters = summary?.distance; }
          } catch(_){}
        }
        if (!seconds) {
          const R=6371,toRad=d=>d*Math.PI/180; const dLatRad=toRad(dLat-oLat), dLonRad=toRad(dLon-oLon); const a=Math.sin(dLatRad/2)**2 + Math.cos(toRad(oLat))*Math.cos(toRad(dLat))*Math.sin(dLonRad/2)**2; const c=2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)); const straightKm=+(R*c).toFixed(2); const minutesApprox=Math.max(5,Math.round((straightKm/65)*60));
          await db.run('INSERT OR REPLACE INTO drive_time_cache (origin, destination, minutes, distance, fetched_at) VALUES (?,?,?,?,?)', [homeBase, addr, minutesApprox, straightKm, new Date().toISOString()]);
          results.push({ address: addrOrig, minutes: minutesApprox, distance_km: straightKm, cached:false, approximate:true });
          continue;
        }
        const minutes = Math.round(seconds/60); const distanceKm = meters!=null?Number((meters/1000).toFixed(2)):null;
        await db.run('INSERT OR REPLACE INTO drive_time_cache (origin, destination, minutes, distance, fetched_at) VALUES (?,?,?,?,?)', [homeBase, addr, minutes, distanceKm, new Date().toISOString()]);
        console.log(`[drive-time][prefetch] stored ${homeBase} -> ${addr}: ${minutes}m, ${distanceKm}km`);
        results.push({ address: addrOrig, minutes, distance_km: distanceKm, cached:false });
      } catch (inner) {
        console.error('[drive-time][prefetch] error', addrOrig, inner.message);
        results.push({ address: addrOrig, error: inner.message });
      }
    }
    res.json({ homeBase, count: results.length, results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
