import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

(async () => {
  const db = await open({ filename: 'schedules.db', driver: sqlite3.Database });
  const rows = await db.all("select address, lon, lat from geocode_cache where address like '1830%' order by fetched_at desc");
  console.log('Dest rows:', rows);
  const rows2 = await db.all("select address, lon, lat from geocode_cache where address like '2950%' order by fetched_at desc");
  console.log('Origin rows:', rows2);
  process.exit();
})();
