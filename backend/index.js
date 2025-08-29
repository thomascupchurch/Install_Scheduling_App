import express from 'express';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import multer from 'multer';
import XLSX from 'xlsx';

const app = express();
const port = process.env.PORT || 3001;
const upload = multer({ dest: 'uploads/' });

app.use(express.json());

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
    address TEXT
  )`);
  // Add columns for migration if missing
  try { await db.exec('ALTER TABLE schedules ADD COLUMN man_hours REAL'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN start_time TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN end_time TEXT'); } catch {}
  try { await db.exec('ALTER TABLE schedules ADD COLUMN address TEXT'); } catch {}
  // Installers table
  await db.exec(`CREATE TABLE IF NOT EXISTS installers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  )`);
  // Many-to-many: schedule_installers
  await db.exec(`CREATE TABLE IF NOT EXISTS schedule_installers (
    schedule_id INTEGER,
    installer_id INTEGER,
    PRIMARY KEY (schedule_id, installer_id),
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
    FOREIGN KEY (installer_id) REFERENCES installers(id) ON DELETE CASCADE
  )`);
  // Settings table for home base
  await db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
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
  res.json(job);
});

app.post('/api/schedules', async (req, res) => {
  try {
    const { job_number, title, date, start_time, end_time, description, installers, man_hours, override } = req.body;
    // Enforce 8-hour limit per installer per day unless override
    if (Array.isArray(installers) && installers.length && man_hours && !override) {
      const day = date.slice(0, 10);
      for (const installer_id of installers) {
        const rows = await db.all('SELECT s.id, s.man_hours FROM schedules s JOIN schedule_installers si ON s.id = si.schedule_id WHERE si.installer_id = ? AND s.date LIKE ?', [installer_id, `${day}%`]);
        let assigned = 0;
        for (const row of rows) {
          const cntRow = await db.get('SELECT COUNT(*) as cnt FROM schedule_installers WHERE schedule_id = ?', [row.id]);
          assigned += (Number(row.man_hours) || 0) / Math.max(1, cntRow.cnt);
        }
        if (assigned + (Number(man_hours) / installers.length) > 8) {
          return res.status(400).json({ error: 'Installer would exceed 8 hours for this day. Use override to allow.' });
        }
      }
    }
    const result = await db.run(
      'INSERT INTO schedules (job_number, title, date, start_time, end_time, description, man_hours) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [job_number, title, date, start_time, end_time, description, man_hours]
    );
    const schedule_id = result.lastID;
    if (Array.isArray(installers)) {
      for (const installer_id of installers) {
        await db.run('INSERT INTO schedule_installers (schedule_id, installer_id) VALUES (?, ?)', [schedule_id, installer_id]);
      }
    }
    res.json({ id: schedule_id, job_number, title, date, start_time, end_time, description, installers, man_hours });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// PATCH endpoint to update description, man_hours, installers, address, etc.
app.patch('/api/schedules/:id', async (req, res) => {
  const { description, man_hours, date, start_time, end_time, installers, address, override } = req.body;
  const { id } = req.params;
  try {
    // Enforce 8-hour limit per installer per day unless override
    if (Array.isArray(installers) && installers.length && man_hours && !override) {
      // Get the date for this job (from body or db)
      let jobDate = date;
      if (!jobDate) {
        const job = await db.get('SELECT date FROM schedules WHERE id = ?', [id]);
        jobDate = job?.date;
      }
      const day = jobDate ? jobDate.slice(0, 10) : null;
      if (day) {
        for (const installer_id of installers) {
          const rows = await db.all('SELECT s.id, s.man_hours FROM schedules s JOIN schedule_installers si ON s.id = si.schedule_id WHERE si.installer_id = ? AND s.date LIKE ?', [installer_id, `${day}%`]);
          let assigned = 0;
          for (const row of rows) {
            if (row.id == id) continue;
            const cntRow = await db.get('SELECT COUNT(*) as cnt FROM schedule_installers WHERE schedule_id = ?', [row.id]);
            assigned += (Number(row.man_hours) || 0) / Math.max(1, cntRow.cnt);
          }
          if (assigned + (Number(man_hours) / installers.length) > 8) {
            return res.status(400).json({ error: 'Installer would exceed 8 hours for this day. Use override to allow.' });
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
    const updated = await db.get('SELECT * FROM schedules WHERE id = ?', [id]);
    const updatedInstallers = await db.all('SELECT installer_id FROM schedule_installers WHERE schedule_id = ?', [id]);
    updated.installers = updatedInstallers.map(i => i.installer_id);
    res.json(updated);
  } catch (e) {
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
  const { name } = req.body;
  const result = await db.run('INSERT INTO installers (name) VALUES (?)', [name]);
  res.json({ id: result.lastID, name });
});

// XLSX import route
app.post('/api/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const workbook = XLSX.readFile(req.file.path);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const jobs = XLSX.utils.sheet_to_json(sheet);
  let imported = 0;
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
      await db.run(
        'INSERT OR IGNORE INTO schedules (job_number, title, date, description, man_hours, address) VALUES (?, ?, ?, ?, ?, ?)',
        [job_number, title, date, description, man_hours, address]
      );
      imported++;
    } catch {}
  }
  res.json({ imported });
});

app.listen(port, () => {
  console.log(`Backend API listening on port ${port}`);
});
