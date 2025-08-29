// Utility to get driving time (in minutes) between two addresses using OpenRouteService API
// Requires an API key from https://openrouteservice.org/
// Usage: await getDrivingTimeMinutes('address1', 'address2')

const ORS_API_KEY = 'YOUR_ORS_API_KEY'; // <-- Replace with your OpenRouteService API key

async function geocodeAddress(address) {
  const url = `https://api.openrouteservice.org/geocode/search?api_key=${ORS_API_KEY}&text=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Geocoding failed');
  const data = await res.json();
  if (!data.features || !data.features.length) throw new Error('No geocode result');
  return data.features[0].geometry.coordinates; // [lon, lat]
}

export async function getDrivingTimeMinutes(fromAddress, toAddress) {
  if (!fromAddress || !toAddress) return null;
  const [fromLon, fromLat] = await geocodeAddress(fromAddress);
  const [toLon, toLat] = await geocodeAddress(toAddress);
  const url = `https://api.openrouteservice.org/v2/directions/driving-car?api_key=${ORS_API_KEY}&start=${fromLon},${fromLat}&end=${toLon},${toLat}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Routing failed');
  const data = await res.json();
  if (!data.routes || !data.routes.length) throw new Error('No route found');
  const seconds = data.routes[0].summary.duration;
  return Math.round(seconds / 60); // minutes
}
