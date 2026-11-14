// ChargeGuard calendar and travel probe.
// Run: osascript -l JavaScript scripts/cg-calendar.js [--print] [--fresh]
// --fresh ignores the saved travel times and asks Apple Maps again.
// It reads calendar events for the next calendar.lookaheadH hours (default 24).
// It skips all-day events, events without a location, and online meetings.
// It also skips a location that it cannot find, or that is more than MAX_TRIP_KM from the reference point.
// The reference point is the origin address, else the home address, else the office address.
// If no reference point exists, it writes no trips and the note "no-address".
// If the current place is home or office and it has an address, it asks Apple Maps for the drive time.
// It writes ~/.chargeguard/trips.json. With --print, it also shows a table on stdout.
// Input files: ~/.chargeguard/config.json and ~/.chargeguard/status.json.
ObjC.import("Foundation");
ObjC.import("EventKit");
ObjC.import("CoreLocation");
ObjC.import("MapKit");

const HOME = ObjC.unwrap($.NSHomeDirectory());
const DIR = HOME + "/.chargeguard";
const TIMEOUT_S = 15; // wait for each geocode and MapKit call
const MAX_TRIP_KM = 300; // a destination farther than this from the reference point is a bad match
const ACCESS_TIMEOUT_S = 120; // wait for the person to answer the access dialog
const CACHE_MAX_MIN = 60; // a saved travel time is valid for this many minutes
// Online meetings. Outlook and Exchange often put plain text, not a URL, in the location.
const ONLINE = new RegExp(
  "zoom\\.us|meet\\.google\\.com|teams\\.microsoft\\.com|webex|^\\s*https?:|" +
    "microsoft teams meeting|teams meeting|zoom meeting|google meet|skype",
  "i"
);

// console.log in osascript writes to stderr. These helpers write to the real streams.
const emit = (handle, text) => handle.writeData($(text + "\n").dataUsingEncoding($.NSUTF8StringEncoding));
const out = (text) => emit($.NSFileHandle.fileHandleWithStandardOutput, text);
const warn = (text) => emit($.NSFileHandle.fileHandleWithStandardError, text);

// Turn an ObjC string into a JS string. A nil value gives "".
const str = (x) => (x && !x.isNil() ? ObjC.unwrap(x) || "" : "");

// Read a JSON file. If the file is missing or broken, return the fallback.
const readJson = (path, fallback) => {
  try {
    const s = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null);
    return s && !s.isNil() ? JSON.parse(ObjC.unwrap(s)) : fallback;
  } catch (e) {
    return fallback;
  }
};

// Run the run loop in small steps until done() is true or the timeout ends.
// Return true if done() became true.
const spin = (done, seconds) => {
  const end = Date.now() + (seconds || TIMEOUT_S) * 1000;
  while (!done() && Date.now() < end) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  }
  return done();
};

// Get calendar access. Return "granted", "denied", or "error".
// Ask the user only if the status is not determined. The script runs often, and the
// completion block of a request runs on a background queue, so avoid the request when possible.
const requestAccess = (store) => {
  const readStatus = () => Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent));
  const status = readStatus();
  if (status === 3) return "granted"; // full access
  if (status === 1 || status === 2 || status === 4) return "denied"; // restricted, denied, write-only
  let finished = false;
  let granted = false;
  // Rule for every callback: use try and finally. An exception in an ObjC block crashes osascript.
  const cb = (ok, err) => {
    try {
      granted = !!ok;
    } catch (e) {
    } finally {
      finished = true;
    }
  };
  try {
    try {
      store.requestFullAccessToEventsWithCompletion(cb); // macOS 14 and later
    } catch (e) {
      store.requestAccessToEntityTypeCompletion($.EKEntityTypeEvent, cb); // older macOS
    }
  } catch (e) {
    warn("Calendar access call failed: " + e);
    return "error";
  }
  if (!spin(() => finished, ACCESS_TIMEOUT_S)) {
    // The callback did not run. Read the status again. The person can answer late, or the callback can be lost.
    if (readStatus() === 3) return "granted";
    warn("Calendar access is not decided. Click Allow in the macOS dialog, then run the script again.");
    return "error";
  }
  return granted ? "granted" : "denied";
};

// Geocode an address with CLGeocoder. Return a CLLocation, or null. Results are cached by text.
const geoCache = {};
const geocode = (text) => {
  if (text in geoCache) return geoCache[text];
  let finished = false;
  let loc = null;
  try {
    let placemark = null; // keep only the ObjC object in the callback. Read the location outside.
    const geocoder = $.CLGeocoder.alloc.init;
    geocoder.geocodeAddressStringCompletionHandler($(text), (placemarks, err) => {
      try {
        if (placemarks && !placemarks.isNil() && placemarks.count > 0) placemark = placemarks.objectAtIndex(0);
      } catch (e) {
      } finally {
        finished = true;
      }
    });
    spin(() => finished);
    loc = placemark ? placemark.location : null;
  } catch (e) {
    loc = null;
  }
  geoCache[text] = loc;
  return loc;
};

// Search a place name with MKLocalSearch. Return a CLLocation, or null.
// JXA cannot bridge MKCoordinateRegion. Do not set a region. The distance filter removes far matches.
const searchCache = {};
const searchPlace = (text) => {
  if (text in searchCache) return searchCache[text];
  let finished = false;
  let loc = null;
  try {
    const req = $.MKLocalSearchRequest.alloc.init;
    req.naturalLanguageQuery = $(text);
    let item = null; // keep only the ObjC object in the callback. Read the location outside.
    $.MKLocalSearch.alloc.initWithRequest(req).startWithCompletionHandler((resp, err) => {
      try {
        if (resp && !resp.isNil() && resp.mapItems.count > 0) item = resp.mapItems.objectAtIndex(0);
      } catch (e) {
      } finally {
        finished = true;
      }
    });
    spin(() => finished);
    loc = item ? item.placemark.location : null;
  } catch (e) {
    loc = null;
  }
  searchCache[text] = loc;
  return loc;
};

// Distance in km between two CLLocation objects.
const kmBetween = (a, b) => a.distanceFromLocation(b) / 1000;

// Get the drive time in minutes between two CLLocation objects. Return null on any failure.
const driveMinutes = (from, to) => {
  try {
    const item = (loc) => $.MKMapItem.alloc.initWithPlacemark($.MKPlacemark.alloc.initWithCoordinate(loc.coordinate));
    const req = $.MKDirectionsRequest.alloc.init;
    req.source = item(from);
    req.destination = item(to);
    req.transportType = $.MKDirectionsTransportTypeAutomobile;
    let finished = false;
    let answer = null; // keep only the ObjC object in the callback. Read the number outside.
    $.MKDirections.alloc.initWithRequest(req).calculateETAWithCompletionHandler((resp, err) => {
      try {
        if (resp && !resp.isNil()) answer = resp;
      } catch (e) {
      } finally {
        finished = true;
      }
    });
    spin(() => finished);
    const seconds = answer ? answer.expectedTravelTime : null;
    return seconds === null || !(seconds >= 0) ? null : Math.ceil(seconds / 60);
  } catch (e) {
    return null;
  }
};

// Get the destination of an event. Use the structured location if it exists.
// Else search the place name. If that gives no result, or a point too far from ref, geocode the text.
// Return { loc, km } or null. km is null if there is no reference point.
const resolveDest = (ev, location, ref) => {
  const sl = ev.structuredLocation;
  const geo = sl && !sl.isNil() ? sl.geoLocation : null;
  if (geo && !geo.isNil()) return { loc: geo, km: ref ? kmBetween(ref, geo) : null }; // the user chose this place
  const near = (loc) => !ref || kmBetween(ref, loc) <= MAX_TRIP_KM;
  // MKLocalSearch finds place names better than CLGeocoder. Use it first. Use CLGeocoder as the fallback.
  let loc = searchPlace(location);
  if (!loc || !near(loc)) loc = geocode(location);
  if (!loc || !near(loc)) return null;
  return { loc: loc, km: ref ? kmBetween(ref, loc) : null };
};

// old holds the last run: trips, computedAt, skipped, and skippedAt. It gives saved results.
// Return { trips, skipped, skippedAt, skippedItems }. An event whose location cannot be resolved
// is not a trip. It goes to skipped. A name like "Room 3A" is an example.
const readTrips = (store, cfg, place, originAddress, old) => {
  const oldTrips = Array.isArray(old.trips) ? old.trips : [];
  const oldAt = old.computedAt;
  const skipFresh = Array.isArray(old.skipped) && Date.now() - Date.parse(old.skippedAt) < CACHE_MAX_MIN * 60000;
  const skipped = skipFresh ? old.skipped.slice() : [];
  const skippedAt = skipFresh ? old.skippedAt : new Date().toISOString();
  const skippedItems = [];
  const lookaheadH = Number((cfg.calendar || {}).lookaheadH) || 24;
  const now = $.NSDate.date;
  const end = $.NSDate.dateWithTimeIntervalSinceNow(lookaheadH * 3600);
  const calendars = store.calendarsForEntityType($.EKEntityTypeEvent);
  const predicate = store.predicateForEventsWithStartDateEndDateCalendars(now, end, calendars);
  const events = store.eventsMatchingPredicate(predicate);
  // Geocode the origin only when one event needs a new Apple Maps call.
  let origin;
  const getOrigin = () => {
    if (origin === undefined) origin = originAddress ? geocode(originAddress) : null;
    return origin;
  };
  // Reference point for the distance filter. Use the origin. Else use the first saved address that
  // geocodes: home, then office. This works also when the place is away or offline.
  let ref;
  const getRef = () => {
    if (ref === undefined) {
      ref = getOrigin();
      for (const name of ["home", "office"]) {
        const a = cfg.places && cfg.places[name] && cfg.places[name].address;
        if (!ref && typeof a === "string" && a.trim()) ref = geocode(a.trim());
      }
      ref = ref || null;
    }
    return ref;
  };
  const trips = [];
  const n = events && !events.isNil() ? events.count : 0;
  // Without a reference point, the distance filter is off and a room name can look like a trip.
  // So write no trips and set the note "no-address".
  if (n > 0 && !getRef()) {
    return { trips: [], skipped: [], skippedAt: null, skippedItems: [], note: "no-address" };
  }
  for (let i = 0; i < n; i++) {
    const ev = events.objectAtIndex(i);
    const location = str(ev.location).trim();
    if (ev.allDay || !location || ONLINE.test(location)) continue;
    const startIso = new Date(ObjC.unwrap(ev.startDate)).toISOString();
    // Step 1: find out if the location is a real place. Reuse the result of the last run if it is recent.
    const prev = oldTrips.find((t) => t.location === location && t.resolved === true);
    const prevFresh = prev && Date.now() - Date.parse(prev.resolvedAt || oldAt) < CACHE_MAX_MIN * 60000;
    let dest; // { loc, km }. undefined means not resolved yet in this run
    let resolvedAt = null;
    let distKm = null;
    if (prevFresh) {
      resolvedAt = prev.resolvedAt || oldAt;
      distKm = typeof prev.distKm === "number" ? prev.distKm : null;
    } else if (skipFresh && skipped.indexOf(location) >= 0) {
      skippedItems.push({ title: str(ev.title), location: location });
      continue;
    } else {
      dest = resolveDest(ev, location, getRef());
      if (!dest) {
        if (skipped.indexOf(location) < 0) skipped.push(location);
        skippedItems.push({ title: str(ev.title), location: location });
        continue;
      }
      resolvedAt = new Date().toISOString();
      distKm = dest.km === null ? null : Math.round(dest.km);
    }
    // Step 2: get the travel time. Reuse a saved time if the location and the origin place are the same and it is recent.
    let travelMin = null;
    let travelAt = null;
    const old1 = oldTrips.find((t) => t.location === location && t.from === place && typeof t.travelMin === "number");
    const savedAt = old1 ? Date.parse(old1.travelAt || oldAt) : NaN;
    if (old1 && Date.now() - savedAt < CACHE_MAX_MIN * 60000) {
      travelMin = old1.travelMin;
      travelAt = old1.travelAt || oldAt;
    } else if (originAddress && getOrigin()) {
      if (dest === undefined) dest = resolveDest(ev, location, getRef());
      if (dest) travelMin = driveMinutes(getOrigin(), dest.loc);
      if (travelMin !== null) travelAt = new Date().toISOString();
    }
    trips.push({
      id: str(ev.eventIdentifier) + "@" + startIso,
      title: str(ev.title),
      start: startIso,
      location: location,
      travelMin: travelMin,
      resolved: true, // the location is a real place. The cache uses it.
      distKm: distKm, // distance in km from the reference point. It shows bad matches.
      resolvedAt: resolvedAt, // when the location was resolved. The cache uses it.
      travelAt: travelAt, // when Apple Maps gave the time. The cache uses it, so a reused value does not stay fresh for ever.
      from: place,
    });
  }
  trips.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { trips: trips, skipped: skipped, skippedAt: skippedAt, skippedItems: skippedItems };
};

// Write trips.json. The atomically flag makes the system write a temp file and rename it.
const writeAtomic = (obj) => {
  const path = DIR + "/trips.json";
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(DIR), true, $(), null);
  const text = $(JSON.stringify(obj, null, 2) + "\n");
  if (!text.writeToFileAtomicallyEncodingError($(path), true, $.NSUTF8StringEncoding, null)) {
    throw new Error("Cannot write " + path);
  }
};

const printTable = (access, trips, skippedItems, note) => {
  const lines = ["Calendar access: " + access, "Trips: " + trips.length];
  for (const t of trips) {
    lines.push([t.title, t.start, t.location, t.travelMin === null ? "-" : t.travelMin + " min", t.distKm === null || t.distKm === undefined ? "- km" : t.distKm + " km"].join(" | "));
  }
  if (note === "no-address") lines.push("No Home or Office address. Save one in Settings > Calendar.");
  for (const k of skippedItems) lines.push("Skipped, location not found: " + k.title + " | " + k.location);
  out(lines.join("\n"));
};

function run(argv) {
  const wantPrint = (argv || []).indexOf("--print") >= 0;
  const fresh = (argv || []).indexOf("--fresh") >= 0;
  const cfg = readJson(DIR + "/config.json", {});
  const status = readJson(DIR + "/status.json", {});
  const place = (status.decision && status.decision.place) || "offline";
  const placeCfg = (cfg.places && cfg.places[place]) || {};
  const address = (place === "home" || place === "office") && typeof placeCfg.address === "string" ? placeCfg.address.trim() : "";

  const store = $.EKEventStore.alloc.init;
  const access = requestAccess(store);
  let res = { trips: [], skipped: [], skippedAt: null, skippedItems: [] };
  if (access === "granted") {
    try {
      const old = fresh ? {} : readJson(DIR + "/trips.json", {});
      res = readTrips(store, cfg, place, address, old);
    } catch (e) {
      warn("Cannot read events: " + e);
    }
  } else if (access === "denied") {
    warn(
      "Calendar access is denied. Open System Settings, Privacy and Security, Calendars. Allow the app that runs this script."
    );
  } else {
    warn("Calendar access request failed.");
  }
  const file = { version: 1, computedAt: new Date().toISOString(), access: access,
    trips: res.trips, skipped: res.skipped, skippedAt: res.skippedAt };
  if (res.note) file.note = res.note;
  writeAtomic(file);
  if (wantPrint) printTable(access, res.trips, res.skippedItems, res.note);
}
