// Frontend utility to request driving time (minutes) from backend cached endpoint
// Usage: await getDrivingTimeMinutes('origin address', 'destination address')

const memCache = new Map(); // key: origin||'__'||destination -> { minutes, distance_km, ts }
const TTL = 1000 * 60 * 30; // 30 min

export async function getDrivingTimeMinutes(origin, destination) {
  if (!origin || !destination) return null;
  const key = origin + '||' + destination;
  const now = Date.now();
  const cached = memCache.get(key);
  if (cached && (now - cached.ts) < TTL) return cached.minutes;
  let res;
  try {
    res = await fetch('/api/driving-time', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ origin, destination }) });
  } catch (e) {
    console.warn('Driving time network error', e);
    return null;
  }
  if (!res.ok) {
    // Capture specific backend error (e.g., missing key or quota) for optional UI usage
    try {
      const errBody = await res.json();
      if (errBody?.error?.includes('key not configured')) {
        console.warn('Driving time disabled: ORS key not configured.');
      } else if (errBody?.error?.match(/quota|limit/i)) {
        console.warn('Driving time quota reached. Using null.');
      } else {
        console.warn('Driving time lookup failed', errBody);
      }
    } catch {}
    return null;
  }
  const data = await res.json();
  if (data.minutes == null) return null;
  memCache.set(key, { minutes: data.minutes, distance_km: data.distance_km, ts: now });
  return data.minutes;
}

// Batch prefetch relative to home base; addresses array of job addresses
export async function prefetchDrivingTimes(homeBase, addresses) {
  if (!homeBase || !Array.isArray(addresses) || !addresses.length) return [];
  const res = await fetch('/api/driving-time/prefetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ homeBase, addresses })
  });
  if (!res.ok) throw new Error('Prefetch failed');
  const data = await res.json();
  const now = Date.now();
  (data.results||[]).forEach(r => {
    if (r.minutes != null) {
      const key = homeBase + '||' + r.address;
      memCache.set(key, { minutes: r.minutes, distance_km: r.distance_km, ts: now });
    }
  });
  return data.results || [];
}

// Access distance from cache (km) without triggering request
export function getCachedDistanceKm(origin, destination) {
  const key = origin + '||' + destination;
  const rec = memCache.get(key);
  return rec?.distance_km ?? null;
}
