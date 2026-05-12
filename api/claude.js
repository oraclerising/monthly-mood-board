// Vercel serverless function — computes a natal chart from birth date/time/location
// POST { date: 'YYYY-MM-DD', time: 'HH:MM' (optional), location: 'City, Country' }
// Returns: { chart: 'Sun 14° Scorpio, House 8\n...', placements, debug }

import * as Astronomy from 'astronomy-engine';

const SIGNS = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
const PLANETS = ['Mercury','Venus','Mars','Jupiter','Saturn','Uranus','Neptune','Pluto'];

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

// Get GEOCENTRIC ecliptic longitude (what astrology uses)
function geocentricLongitude(body, date) {
  if (body === 'Sun') {
    return Astronomy.SunPosition(date).elon;
  }
  if (body === 'Moon') {
    return Astronomy.EclipticGeoMoon(date).lon;
  }
  // For planets: get geocentric Cartesian vector, convert to ecliptic
  const geoVec = Astronomy.GeoVector(body, date, true);
  const ecl = Astronomy.Ecliptic(geoVec);
  return ecl.elon;
}

function calculateAscendant(date, lat, lng) {
  // Greenwich Sidereal Time in hours, convert to degrees, add local longitude
  const gmstHours = Astronomy.SiderealTime(date);
  const lstDeg = ((gmstHours * 15 + lng) % 360 + 360) % 360;

  // True obliquity of the ecliptic at this date
  const tilt = Astronomy.e_tilt(date);
  const obliquity = tilt.tobl;

  const lstR = toRad(lstDeg);
  const latR = toRad(lat);
  const oblR = toRad(obliquity);

  // Swiss Ephemeris formula:
  // λ_ASC = atan2(cos(LST), -sin(LST)*cos(ε) - tan(φ)*sin(ε))
  const y = Math.cos(lstR);
  const x = -Math.sin(lstR) * Math.cos(oblR) - Math.tan(latR) * Math.sin(oblR);
  let asc = toDeg(Math.atan2(y, x));
  asc = ((asc % 360) + 360) % 360;
  return asc;
}

function calculateMidheaven(date, lng) {
  const gmstHours = Astronomy.SiderealTime(date);
  const lstDeg = ((gmstHours * 15 + lng) % 360 + 360) % 360;
  const tilt = Astronomy.e_tilt(date);
  const oblR = toRad(tilt.tobl);
  const lstR = toRad(lstDeg);
  let mc = toDeg(Math.atan2(Math.sin(lstR), Math.cos(lstR) * Math.cos(oblR)));
  mc = ((mc % 360) + 360) % 360;
  return mc;
}

// Mean lunar North Node — analytic formula
function calculateNorthNode(date) {
  const j2000 = new Date('2000-01-01T12:00:00Z');
  const days = (date - j2000) / 86400000;
  let node = 125.04452 - 0.05295376 * days;
  return ((node % 360) + 360) % 360;
}

async function geocode(location) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'MoodBoard/1.0 (chelsey)' },
  });
  if (!res.ok) throw new Error('Geocoding service failed');
  const data = await res.json();
  if (!data.length) throw new Error(`Couldn't find location: ${location}`);
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name };
}

async function getTimezoneOffset(date, time, location, apiKey) {
  if (!time || !location) return 0;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 30,
      messages: [{
        role: 'user',
        content: `For ${location} on ${date} at ${time} local time, what is the UTC offset in hours? Consider daylight saving time and historical timezone changes (e.g. dates before standardized DST). Reply with ONLY a signed number like "-8" or "-5" or "5.5". No other text, no units, no "UTC" prefix.`
      }],
    }),
  });
  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  const match = text.match(/-?\d+(\.\d+)?/);
  if (!match) return 0;
  return parseFloat(match[0]);
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
        return res.status(400).json({ error: `Could not geocode "${location}": ${e.message}` });
      }
    }

    // Resolve UTC datetime
    let utcDate;
    let tzOffset = 0;
    if (time && location) {
      tzOffset = await getTimezoneOffset(date, time, location, apiKey);
      // Build a UTC moment for the given local clock-time + offset
      const localUTC = new Date(`${date}T${time}:00Z`); // parse as UTC
      utcDate = new Date(localUTC.getTime() - tzOffset * 3600000);
    } else {
      // Default to solar noon UTC if no time
      utcDate = new Date(`${date}T12:00:00Z`);
    }
    if (isNaN(utcDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date/time format' });
    }

    // Compute planet positions (GEOCENTRIC)
    const placements = [];
    const errors = [];
    // Sun first
    try {
      placements.push({ body: 'Sun', ...signOf(geocentricLongitude('Sun', utcDate)) });
    } catch(e) { errors.push(`Sun: ${e.message}`); }
    // Moon
    try {
      placements.push({ body: 'Moon', ...signOf(geocentricLongitude('Moon', utcDate)) });
    } catch(e) { errors.push(`Moon: ${e.message}`); }
    // Planets
    for (const body of PLANETS) {
      try {
        placements.push({ body, ...signOf(geocentricLongitude(body, utcDate)) });
      } catch(e) {
        errors.push(`${body}: ${e.message}`);
      }
    }
    // North Node
    placements.push({ body: 'North Node', ...signOf(calculateNorthNode(utcDate)) });

    // Ascendant + MC (only if we have time and location)
    let ascendant = null, midheaven = null;
    const hasFullBirth = !!time && !!location;
    if (hasFullBirth) {
      try {
        ascendant = signOf(calculateAscendant(utcDate, geo.lat, geo.lng));
        midheaven = signOf(calculateMidheaven(utcDate, geo.lng));
      } catch(e) { errors.push(`Ascendant/MC: ${e.message}`); }
    }

    // Whole-sign houses: ASC sign = House 1
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
      lines.push(`[Note: ${!time ? 'No birth time provided — Ascendant and houses omitted.' : 'No location — houses unavailable.'}]\n`);
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
      tzOffset,
      errors,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
