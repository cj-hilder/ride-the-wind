import {
  DEFAULT_UNITS, setFormatSettings, getFormatSettings,
  formatTemperature, formatTimeOfDay, formatElapsed, formatRideSpeed,
  formatWindSpeed, formatDistance, formatRainfall, formatClockString, formatElevation,
  rideSpeedToCanonicalKmh, canonicalKmhToRideSpeed, rideSpeedStep,
  rideSpeedUnitLabel, rideSpeedBounds, _setSystemHour12,
} from './src/lib/format.js';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`)); };

// Helper: build a settings override
const S = (o) => ({ ...DEFAULT_UNITS, ...o });

// Fixed epoch for time-of-day tests: choose local wall-clock via components.
const at = (h, m) => { const d = new Date(2026, 0, 2, h, m, 0); return d.getTime(); };

console.log('Temperature:');
{
  ok('°C default', formatTemperature(12, S({ temp: 'c' })) === '12°C', formatTemperature(12, S({ temp: 'c' })));
  ok('°F', formatTemperature(12, S({ temp: 'f' })) === '54°F', formatTemperature(12, S({ temp: 'f' })));
  ok('0°C → 32°F', formatTemperature(0, S({ temp: 'f' })) === '32°F', formatTemperature(0, S({ temp: 'f' })));
  ok('negative °C', formatTemperature(-5, S({ temp: 'c' })) === '-5°C', formatTemperature(-5, S({ temp: 'c' })));
  ok('negative °C → °F', formatTemperature(-5, S({ temp: 'f' })) === '23°F', formatTemperature(-5, S({ temp: 'f' })));
  ok('rounds to whole', formatTemperature(12.6, S({ temp: 'c' })) === '13°C', formatTemperature(12.6, S({ temp: 'c' })));
  ok('null → empty', formatTemperature(null) === '');
}

console.log('Time of day (follows system clock):');
{
  _setSystemHour12(false);
  ok('24h', formatTimeOfDay(at(8, 45)) === '08:45', formatTimeOfDay(at(8, 45)));
  ok('24h double digit', formatTimeOfDay(at(17, 5)) === '17:05', formatTimeOfDay(at(17, 5)));
  _setSystemHour12(true);
  ok('12h morning', formatTimeOfDay(at(8, 45)) === '8:45 am', formatTimeOfDay(at(8, 45)));
  ok('12h afternoon', formatTimeOfDay(at(17, 5)) === '5:05 pm', formatTimeOfDay(at(17, 5)));
  ok('12h noon = 12:00 pm', formatTimeOfDay(at(12, 0)) === '12:00 pm', formatTimeOfDay(at(12, 0)));
  ok('12h midnight = 12:00 am', formatTimeOfDay(at(0, 0)) === '12:00 am', formatTimeOfDay(at(0, 0)));
  ok('12h 00:30 = 12:30 am', formatTimeOfDay(at(0, 30)) === '12:30 am', formatTimeOfDay(at(0, 30)));
  _setSystemHour12(null); // restore detection
}

console.log('Elapsed / duration:');
{
  ok('9 min', formatElapsed(9 * 60, S({})) === '9 min', formatElapsed(9 * 60, S({})));
  ok('45 min', formatElapsed(45 * 60, S({})) === '45 min');
  ok('under 1h ignores duration form', formatElapsed(45 * 60, S({ duration: 'colon' })) === '45 min');
  ok('rounds to whole min', formatElapsed(9 * 60 + 40, S({})) === '10 min', formatElapsed(9 * 60 + 40, S({})));
  // ≥1h across the three forms (90 min = 1h30)
  ok('form1 min: 90 min', formatElapsed(90 * 60, S({ duration: 'min' })) === '90 min', formatElapsed(90 * 60, S({ duration: 'min' })));
  ok('form2 hrmin: 1 hr 30', formatElapsed(90 * 60, S({ duration: 'hrmin' })) === '1 hr 30', formatElapsed(90 * 60, S({ duration: 'hrmin' })));
  ok('form3 colon: 1:30', formatElapsed(90 * 60, S({ duration: 'colon' })) === '1:30', formatElapsed(90 * 60, S({ duration: 'colon' })));
  // leading-zero minutes in forms 2 & 3
  ok('form2 leading-zero min: 2 hr 05', formatElapsed((2 * 60 + 5) * 60, S({ duration: 'hrmin' })) === '2 hr 05', formatElapsed((2 * 60 + 5) * 60, S({ duration: 'hrmin' })));
  ok('form3 leading-zero min: 2:05', formatElapsed((2 * 60 + 5) * 60, S({ duration: 'colon' })) === '2:05');
  // exactly 1h
  ok('exactly 60 min form2: 1 hr 00', formatElapsed(60 * 60, S({ duration: 'hrmin' })) === '1 hr 00', formatElapsed(60 * 60, S({ duration: 'hrmin' })));
  ok('exactly 60 min form1: 60 min', formatElapsed(60 * 60, S({ duration: 'min' })) === '60 min');
  ok('59 min stays min form2', formatElapsed(59 * 60, S({ duration: 'hrmin' })) === '59 min');
  ok('negative → empty', formatElapsed(-5) === '');
}

console.log('Ride speed:');
{
  ok('km/h', formatRideSpeed(24, S({ rideSpeed: 'kmh' })) === '24 km/h', formatRideSpeed(24, S({ rideSpeed: 'kmh' })));
  ok('mph', formatRideSpeed(24, S({ rideSpeed: 'mph' })) === '15 mph', formatRideSpeed(24, S({ rideSpeed: 'mph' })));
  ok('mph whole dp same as kmh', formatRideSpeed(32.19, S({ rideSpeed: 'mph' })) === '20 mph', formatRideSpeed(32.19, S({ rideSpeed: 'mph' })));
  ok('1 dp when asked', formatRideSpeed(24, S({ rideSpeed: 'kmh' }), { dp: 1 }) === '24.0 km/h');
}

console.log('Wind speed:');
{
  ok('km/h', formatWindSpeed(22, S({ windSpeed: 'kmh' })) === '22 km/h');
  ok('mph', formatWindSpeed(22, S({ windSpeed: 'mph' })) === '14 mph', formatWindSpeed(22, S({ windSpeed: 'mph' })));
  ok('kt', formatWindSpeed(22, S({ windSpeed: 'kt' })) === '12 kt', formatWindSpeed(22, S({ windSpeed: 'kt' })));
}

console.log('Distance:');
{
  ok('km 1dp', formatDistance(5.2, S({ distance: 'km' })) === '5.2 km', formatDistance(5.2, S({ distance: 'km' })));
  ok('mi 1dp mirrors', formatDistance(5.2, S({ distance: 'mi' })) === '3.2 mi', formatDistance(5.2, S({ distance: 'mi' })));
  ok('km 2dp', formatDistance(5.23, S({ distance: 'km' }), { dp: 2 }) === '5.23 km');
  ok('mi 2dp', formatDistance(1.609344, S({ distance: 'mi' }), { dp: 2 }) === '1.00 mi', formatDistance(1.609344, S({ distance: 'mi' }), { dp: 2 }));
}

console.log('Rainfall:');
{
  ok('mm 1dp', formatRainfall(1.2, S({ rainfall: 'mm' })) === '1.2 mm');
  ok('mm rate', formatRainfall(1.2, S({ rainfall: 'mm' }), { rate: true }) === '1.2 mm/h');
  ok('in gets +1 dp', formatRainfall(1.2, S({ rainfall: 'in' })) === '0.05 in', formatRainfall(1.2, S({ rainfall: 'in' })));
  ok('in rate', formatRainfall(1.2, S({ rainfall: 'in' }), { rate: true }) === '0.05 in/h');
  ok('mm 2dp → in 3dp', formatRainfall(2.5, S({ rainfall: 'in' }), { mmDp: 2 }) === '0.098 in', formatRainfall(2.5, S({ rainfall: 'in' }), { mmDp: 2 }));
}

console.log('Decimal separator:');
{
  ok('comma on distance', formatDistance(5.2, S({ decimal: 'comma' })) === '5,2 km', formatDistance(5.2, S({ decimal: 'comma' })));
  ok('comma on rainfall in', formatRainfall(1.2, S({ rainfall: 'in', decimal: 'comma' })) === '0,05 in');
  ok('comma on speed 1dp', formatRideSpeed(24, S({ decimal: 'comma' }), { dp: 1 }) === '24,0 km/h');
  ok('dot default', formatDistance(5.2, S({ decimal: 'dot' })) === '5.2 km');
}

console.log('Inverse seam (baseline-speed input):');
{
  ok('mph→kmh', Math.abs(rideSpeedToCanonicalKmh(15, S({ rideSpeed: 'mph' })) - 15 * 1.609344) < 1e-9);
  ok('kmh identity', rideSpeedToCanonicalKmh(24, S({ rideSpeed: 'kmh' })) === 24);
  ok('kmh→mph seed', Math.abs(canonicalKmhToRideSpeed(24, S({ rideSpeed: 'mph' })) - 24 / 1.609344) < 1e-9);
  ok('round-trip stable', Math.abs(rideSpeedToCanonicalKmh(canonicalKmhToRideSpeed(24, S({ rideSpeed: 'mph' })), S({ rideSpeed: 'mph' })) - 24) < 1e-9);
  ok('step 0.5', rideSpeedStep() === 0.5);
  ok('unit label mph', rideSpeedUnitLabel(S({ rideSpeed: 'mph' })) === 'mph');
  ok('unit label kmh', rideSpeedUnitLabel(S({ rideSpeed: 'kmh' })) === 'km/h');
  const b = rideSpeedBounds(10, 40, S({ rideSpeed: 'mph' }));
  ok('bounds convert', Math.abs(b.min - 10 / 1.609344) < 1e-9 && Math.abs(b.max - 40 / 1.609344) < 1e-9);
  const bk = rideSpeedBounds(10, 40, S({ rideSpeed: 'kmh' }));
  ok('bounds identity km', bk.min === 10 && bk.max === 40);
}

console.log('Snapshot mechanism (option B):');
{
  setFormatSettings({ temp: 'f', rideSpeed: 'mph', decimal: 'comma' });
  ok('snapshot used when no arg (temp)', formatTemperature(0) === '32°F', formatTemperature(0));
  ok('snapshot used when no arg (speed)', formatRideSpeed(24) === '15 mph', formatRideSpeed(24));
  ok('explicit arg overrides snapshot', formatTemperature(0, S({ temp: 'c' })) === '0°C');
  ok('getFormatSettings reflects set', getFormatSettings().temp === 'f');
  ok('partial set falls back to defaults', getFormatSettings().windSpeed === 'kmh');
  setFormatSettings(DEFAULT_UNITS); // reset
  ok('reset to defaults', formatRideSpeed(24) === '24 km/h');
  ok('null set → defaults', (setFormatSettings(null), getFormatSettings().temp === 'c'));
}

console.log('Clock string (config HH:MM display, follows system):');
{
  _setSystemHour12(false);
  ok('24h passthrough', formatClockString('08:45') === '08:45');
  _setSystemHour12(true);
  ok('12h morning', formatClockString('08:45') === '8:45 am', formatClockString('08:45'));
  ok('12h afternoon', formatClockString('17:05') === '5:05 pm', formatClockString('17:05'));
  ok('12h noon', formatClockString('12:00') === '12:00 pm');
  ok('12h midnight', formatClockString('00:00') === '12:00 am');
  ok('malformed passthrough', formatClockString('now') === 'now');
  _setSystemHour12(null);
}

console.log('Elevation (couples to distance):');
{
  ok('metres with km', formatElevation(340, S({ distance: 'km' })) === '340 m');
  ok('feet with mi', formatElevation(340, S({ distance: 'mi' })) === '1115 ft', formatElevation(340, S({ distance: 'mi' })));
  ok('rounds whole', formatElevation(340.6, S({ distance: 'km' })) === '341 m');
  ok('comma decimal irrelevant (whole)', formatElevation(340, S({ distance: 'km', decimal: 'comma' })) === '340 m');
  ok('null → empty', formatElevation(null) === '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
