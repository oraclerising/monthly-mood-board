// Vercel serverless function — computes a natal chart from birth date/time/location
// POST { date: 'YYYY-MM-DD', time: 'HH:MM' (optional), location: 'City, Country' }
// Returns: { chart: 'Sun 14° Scorpio, House 8\nMoon 22° Pisces, House 12\n...' }

import * as Astronomy from 'astronomy-engine';

const SIGNS = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
const BODIES = ['Sun','Moon','Mercury','Venus','Mars','Jupiter','Saturn','Uranus','Neptune','Pluto'];

const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

function signOf(longitude) {
  const norm = ((longitude % 360) + 360) % 360;
  return {
    sign: SIGNS[Math.floor(norm / 30)],
    degree: Math.floor(norm % 30),
    longitude: norm,
  };
}

function calculateAscendant(date, lat, lng) {
  // Greenwich Mean Sidereal Time in hours, then to degrees, then add local longitude
  const gmst = Astronomy.SiderealTime(date);
  const lst = (gmst * 15 + lng) % 360;
  const lstNorm = (lst + 360) % 360;

  // Obliquity of the ecliptic
  const tilt = Astronomy.e_tilt(date);
  const obliquity = tilt.mobl;

  const lstR = toRad(lstNorm);
  const latR = toRad(lat);
  const oblR = toRad(obliquity);

  const y = -Math.cos(lstR);
  const x = Math.sin(lstR) * Math.cos(oblR) + Math.tan(latR) * Math.sin(oblR);
  let asc = toDeg(Math.atan2(y, x));
  asc = ((asc % 360) + 360) % 360;
  return asc;
}

function calculateMidheaven(date, lng) {
  const gmst = Astronomy.SiderealTime(date);
  const lst = (gmst * 15 + lng) % 360;
  const lstNorm = (lst + 360) % 360;
  const tilt = Astronomy.e_tilt(date);
  const oblR = toRad(tilt.mobl);
  const lstR = toRad(lstNorm);
  // MC formula
  let mc = toDeg(Math.atan2(Math.tan(lstR), Math.cos(oblR)));
  // Adjust quadrant
  if (lstNorm > 90 && lstNorm < 270) mc += 180;
  mc = ((mc % 360) + 360) % 360;
  return mc;
}

// Mean lunar node (North Node) — analytic formula
function calculateNorthNode(date) {
  const j2000 = new Date('2000-01-01T12:00:00Z');
  const days = (date - j2000) / 86400000;
  // Mean longitude of ascending node
  let node = 125.04452 - 0.05295376 * days;
  node = ((node % 360) + 360) % 360;
  return node;
}

async function geocode(location) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'MoodBoard/1.0 (chelsey)' },
  });
  if (!res.ok) throw new Error('Geocoding failed');
  const data = await res.json();
  if (!data.length) throw new Error(`Couldn't find location: ${location}`);
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name };
}

// Convert local birth time to UTC by asking Claude for the historical timezone offset
async function localToUTC(date, time, location, apiKey) {
  if (!time) {
    // No time provided — use solar noon UTC as a reasonable default
    return new Date(`${date}T12:00:00Z`);
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: `What was the UTC offset (in hours) for ${location} on ${date} at ${time} local time? Account for daylight saving time and historical timezone changes. Reply with ONLY a number like -5 or -4 or 5.5 — nothing else.`
      }],
    }),
  });
  const data = await res.json();
  const text = (data.content?.[0]?.text || '0').trim();
  const offset = parseFloat(text.match(/-?\d+(\.\d+)?/)?.[0] || '0');

  // Build UTC moment: local time minus offset
  const local = new Date(`${date}T${time}:00`);
  return new Date(local.getTime() - offset * 3600000);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });

  try {
    const { date, time, location } = req.body;
    if (!date) return res.status(400).json({ error: 'date is required' });

    // Geocode
    let geo = { lat: 0, lng: 0, display: '' };
    if (location) {
      try { geo = await geocode(location); } catch(e) {
        return res.status(400).json({ error: `Location not found: ${location}` });
      }
    }

    // Convert local time to UTC
    const utcDate = await localToUTC(date, time, location, apiKey);
    if (isNaN(utcDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date/time format' });
    }

    // Compute planet positions
    const placements = [];
    for (const body of BODIES) {
      try {
        const lon = Astronomy.EclipticLongitude(body, utcDate);
        placements.push({ body, ...signOf(lon) });
      } catch(e) {
        // skip if astronomy-engine doesn't support
      }
    }
    // North Node
    placements.push({ body: 'North Node', ...signOf(calculateNorthNode(utcDate)) });

    // Ascendant + MC (only if we have time and location)
    let ascendant = null, midheaven = null;
    const hasFullBirth = !!time && !!location;
    if (hasFullBirth) {
      ascendant = signOf(calculateAscendant(utcDate, geo.lat, geo.lng));
      midheaven = signOf(calculateMidheaven(utcDate, geo.lng));
    }

    // Whole sign houses: ASC sign = House 1
    const houseOfSign = {};
    if (ascendant) {
      const ascIdx = SIGNS.indexOf(ascendant.sign);
      SIGNS.forEach((s, i) => {
        houseOfSign[s] = ((i - ascIdx + 12) % 12) + 1;
      });
    }

    // Format chart text
    const lines = [];
    if (!hasFullBirth) {
      lines.push(`[Note: ${!time ? 'No birth time provided — Ascendant and houses omitted.' : 'No location provided — houses unavailable.'}]\n`);
    }
    if (ascendant) lines.push(`Ascendant ${ascendant.degree}° ${ascendant.sign}`);
    if (midheaven) lines.push(`Midheaven ${midheaven.degree}° ${midheaven.sign}`);
    for (const p of placements) {
      const house = houseOfSign[p.sign];
      lines.push(`${p.body} ${p.degree}° ${p.sign}${house ? `, House ${house}` : ''}`);
    }

    return res.status(200).json({
      chart: lines.join('\n'),
      placements,
      ascendant,
      midheaven,
      location: geo.display,
      utc: utcDate.toISOString(),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
