require('dotenv').config();

const express = require('express');
const path = require('path');
const { searchFlight, searchDOHDirect } = require('./matrix_engine');
const { resolveAirport } = require('./airports');

const app = express();
const PORT = process.env.PORT || 3000;

// MAX_PARALLEL: max concurrent Chromium instances.
// 0 = unlimited (good for high-RAM machines), 2 = safe for 512MB-1GB VPS.
const MAX_PARALLEL_RAW = parseInt(process.env.MAX_PARALLEL, 10);
const MAX_PARALLEL = Number.isInteger(MAX_PARALLEL_RAW) && MAX_PARALLEL_RAW > 0 ? MAX_PARALLEL_RAW : 0;

// Global unhandled rejection handler — prevents process crash from unexpected async errors
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Default origins (7 airports)
const DEFAULT_ORIGINS = ['DMM', 'BAH', 'RUH', 'DXB', 'AUH', 'KWI', 'MCT'];

// Validate airport code: exactly 3 uppercase letters
function isValidAirportCode(code) {
  return /^[A-Z]{3}$/.test(code);
}

// Validate date string: YYYY-MM-DD
function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(new Date(str).getTime());
}

// Resolve destination endpoint
app.get('/api/resolve', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ resolved: null });
  const result = resolveAirport(q);
  res.json({ resolved: result });
});

// SSE endpoint for flight search
app.get('/api/search', async (req, res) => {
  const { destination, depart, returnDate, origins } = req.query;

  // Input validation
  if (!destination || !depart || !returnDate) {
    return res.status(400).json({ error: 'Missing required fields: destination, depart, returnDate' });
  }
  if (!isValidDate(depart) || !isValidDate(returnDate)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }
  if (new Date(returnDate) <= new Date(depart)) {
    return res.status(400).json({ error: 'returnDate must be after depart.' });
  }

  // Resolve destination
  const resolved = resolveAirport(destination);
  const destCode = resolved ? resolved.code : destination.toUpperCase().slice(0, 3);
  const destLabel = resolved ? resolved.label : destCode;

  if (!isValidAirportCode(destCode)) {
    return res.status(400).json({ error: `Cannot resolve destination: ${destination}` });
  }

  // Parse and validate origins
  const rawOrigins = origins ? origins.split(',').map(o => o.trim().toUpperCase().slice(0, 3)) : DEFAULT_ORIGINS;
  const originList = rawOrigins.filter(isValidAirportCode);
  if (originList.length === 0) {
    return res.status(400).json({ error: 'No valid origin airport codes provided.' });
  }

  const totalSearches = originList.length + 1; // +1 for DOH

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
    // No wildcard CORS — frontend is served from same origin
  });

  let clientConnected = true;
  req.on('close', () => {
    clientConnected = false;
    console.log('[SSE] Client disconnected, stopping search');
  });

  const send = (event, data) => {
    if (!clientConnected) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (_) {
      clientConnected = false;
    }
  };

  send('info', {
    destination: destCode,
    destinationLabel: destLabel,
    depart,
    returnDate,
    origins: originList,
    totalSearches,
    airline: 'Qatar Airways',
    cabin: 'Business',
    routing: 'Via DOH'
  });

  // Build all search tasks: DOH first, then origins
  const allTasks = [];

  // DOH direct benchmark — FIRST
  allTasks.push({
    type: 'doh',
    origin: 'DOH',
    index: 1,
    fn: () => {
      send('progress', { origin: 'DOH', index: 1, total: totalSearches, status: 'searching', isDOHDirect: true });
      return searchDOHDirect(destCode, depart, returnDate, (progress) => {
        send('progress', { origin: 'DOH', index: 1, total: totalSearches, status: 'searching', detail: progress.message, isDOHDirect: true });
      });
    }
  });

  // Origin searches
  originList.forEach((origin, i) => {
    allTasks.push({
      type: 'origin',
      origin,
      index: i + 2,
      fn: () => {
        send('progress', { origin, index: i + 2, total: totalSearches, status: 'searching' });
        return searchFlight(origin, destCode, depart, returnDate, (progress) => {
          send('progress', { origin, index: i + 2, total: totalSearches, status: 'searching', detail: progress.message });
        });
      }
    });
  });

  const batchSize = MAX_PARALLEL > 0 ? MAX_PARALLEL : allTasks.length;
  const originResults = new Map(); // origin -> result
  let dohResult = null;
  let completed = 0;

  console.log(`[SEARCH] dest=${destCode} origins=${originList.join(',')} total=${totalSearches} batchSize=${batchSize}`);

  for (let i = 0; i < allTasks.length; i += batchSize) {
    if (!clientConnected) break;

    const batch = allTasks.slice(i, i + batchSize);
    console.log(`[BATCH] Running: ${batch.map(t => t.origin).join(' + ')}`);

    const settled = await Promise.allSettled(batch.map(t => t.fn()));

    for (let j = 0; j < batch.length; j++) {
      const task = batch[j];
      const outcome = settled[j];
      completed++;

      if (task.type === 'doh') {
        dohResult = outcome.status === 'fulfilled'
          ? outcome.value
          : { found: false, origin: 'DOH', isDOHDirect: true, error: outcome.reason?.message };
        send('doh_result', dohResult);
      } else {
        const result = outcome.status === 'fulfilled'
          ? outcome.value
          : { origin: task.origin, found: false, error: outcome.reason?.message };
        originResults.set(task.origin, result);
        send('result', { origin: task.origin, index: task.index, total: totalSearches, ...result });
      }

      send('progress', {
        origin: task.origin, index: completed, total: totalSearches,
        status: 'done', detail: `Completed (${completed}/${totalSearches})`
      });
    }
  }

  // ── RETRY PHASE ──
  // Only retry origins that errored (not genuine "no flights found" results — those are valid)
  const failedOrigins = [];
  for (const [origin, result] of originResults) {
    if (result.error) failedOrigins.push(origin);
  }
  const dohFailed = dohResult && !!dohResult.error;

  if ((failedOrigins.length > 0 || dohFailed) && clientConnected) {
    const retryTotal = failedOrigins.length + (dohFailed ? 1 : 0);
    send('retry_start', { failedOrigins, dohFailed, retryTotal });
    console.log(`[RETRY] Retrying ${retryTotal} errored: ${failedOrigins.join(', ')}${dohFailed ? ' + DOH' : ''}`);

    if (dohFailed && clientConnected) {
      send('retry_progress', { origin: 'DOH', isDOHDirect: true });
      try {
        const retryResult = await searchDOHDirect(destCode, depart, returnDate, (p) => {
          send('retry_progress', { origin: 'DOH', detail: p.message, isDOHDirect: true });
        });
        if (retryResult && retryResult.found && retryResult.cheapestUSD) {
          dohResult = retryResult;
          console.log('[RETRY] DOH succeeded on retry');
        }
      } catch (err) {
        console.error('[RETRY] DOH still failed:', err.message);
      }
      send('doh_result', dohResult);
    }

    const retryBatchSize = MAX_PARALLEL > 0 ? MAX_PARALLEL : failedOrigins.length;
    for (let i = 0; i < failedOrigins.length; i += retryBatchSize) {
      if (!clientConnected) break;
      const batch = failedOrigins.slice(i, i + retryBatchSize);
      const retryTasks = batch.map(origin => {
        send('retry_progress', { origin });
        return searchFlight(origin, destCode, depart, returnDate, (p) => {
          send('retry_progress', { origin, detail: p.message });
        }).then(result => ({ origin, result }))
          .catch(err => ({ origin, result: { origin, found: false, error: err.message } }));
      });

      const retryResults = await Promise.all(retryTasks);
      for (const { origin, result } of retryResults) {
        originResults.set(origin, result);
        console.log(`[RETRY] ${origin}: ${result.found ? '$' + result.cheapestUSD : 'still no flights'}`);
        send('result', { origin, ...result, isRetry: true });
      }
    }
  }

  // Final sorted results
  const validResults = Array.from(originResults.values()).filter(r => r.found && r.cheapestUSD);
  validResults.sort((a, b) => a.cheapestUSD - b.cheapestUSD);

  send('done', {
    results: validResults,
    winner: validResults.length > 0 ? validResults[0] : null,
    dohDirect: dohResult,
    totalSearched: originList.length,
    totalFound: validResults.length
  });

  res.end();
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0', defaultOrigins: DEFAULT_ORIGINS, maxParallel: MAX_PARALLEL || 'unlimited' });
});

app.listen(PORT, () => {
  console.log(`QR Flight Search v2 running on http://localhost:${PORT}`);
  console.log(`Default origins: ${DEFAULT_ORIGINS.join(', ')}`);
  console.log(`Parallel: ${MAX_PARALLEL > 0 ? MAX_PARALLEL : 'all at once'}`);
  console.log('Airline: Qatar Airways | Cabin: Business | Routing: O:QR+ X:DOH');
});
