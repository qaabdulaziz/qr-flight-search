const express = require('express');
const path = require('path');
const { searchFlight, searchDOHDirect } = require('./matrix_engine');
const { resolveAirport } = require('./airports');

const app = express();
const PORT = process.env.PORT || 3000;
// Batch size = total searches. All origins run in parallel.
// Override with MAX_PARALLEL env var if needed (e.g. MAX_PARALLEL=2 on low-RAM VPS)
const MAX_PARALLEL = process.env.MAX_PARALLEL ? parseInt(process.env.MAX_PARALLEL) : 0; // 0 = unlimited

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Default origins (7 airports)
const DEFAULT_ORIGINS = ['DMM', 'BAH', 'RUH', 'DXB', 'AUH', 'KWI', 'MCT'];

// Resolve destination endpoint
app.get('/api/resolve', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ resolved: null });
  const result = resolveAirport(q);
  res.json({ resolved: result });
});

/**
 * Run an array of async tasks in batches of `batchSize`.
 * Each task is a function that returns a Promise.
 */
async function runInBatches(tasks, batchSize) {
  const results = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fn => fn()));
    results.push(...batchResults);
  }
  return results;
}

// SSE endpoint for flight search
app.get('/api/search', async (req, res) => {
  const { destination, depart, returnDate, origins } = req.query;

  // Validate inputs
  if (!destination || !depart || !returnDate) {
    res.status(400).json({ error: 'Missing required fields: destination, depart, returnDate' });
    return;
  }

  // Resolve destination (city name or airport code)
  const resolved = resolveAirport(destination);
  const destCode = resolved ? resolved.code : destination.toUpperCase();
  const destLabel = resolved ? resolved.label : destCode;

  // Parse origins
  const originList = origins ? origins.split(',').map(o => o.trim().toUpperCase()) : DEFAULT_ORIGINS;

  // Total searches = origins + DOH direct
  const totalSearches = originList.length + 1;

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

  // Build all search tasks: DOH benchmark FIRST, then origins
  // Each task is an object { type, origin, index, fn }
  const allTasks = [];

  // DOH direct benchmark search - FIRST
  allTasks.push({
    type: 'doh',
    origin: 'DOH',
    index: 1,
    fn: () => {
      send('progress', {
        origin: 'DOH', index: 1, total: totalSearches,
        status: 'searching', isDOHDirect: true
      });
      return searchDOHDirect(destCode, depart, returnDate, (progress) => {
        send('progress', {
          origin: 'DOH', index: 1, total: totalSearches,
          status: 'searching', detail: progress.message, isDOHDirect: true
        });
      });
    }
  });

  // Origin searches - AFTER DOH
  originList.forEach((origin, i) => {
    allTasks.push({
      type: 'origin',
      origin,
      index: i + 2, // +2 because DOH is index 1
      fn: () => {
        send('progress', {
          origin, index: i + 2, total: totalSearches, status: 'searching'
        });
        return searchFlight(origin, destCode, depart, returnDate, (progress) => {
          send('progress', {
            origin, index: i + 2, total: totalSearches,
            status: 'searching', detail: progress.message
          });
        });
      }
    });
  });

  // Run in batches - default: all parallel. Use MAX_PARALLEL to limit.
  const batchSize = MAX_PARALLEL > 0 ? MAX_PARALLEL : allTasks.length;
  const originResults = new Map(); // origin -> result
  let dohResult = null;
  let completed = 0;

  console.log(`[SEARCH] ${totalSearches} searches, batch size: ${batchSize}`);

  for (let i = 0; i < allTasks.length; i += batchSize) {
    const batch = allTasks.slice(i, i + batchSize);
    const batchNames = batch.map(t => t.origin).join(' + ');
    console.log(`[BATCH] Running: ${batchNames}`);

    const settled = await Promise.allSettled(batch.map(t => t.fn()));

    // Process results from this batch
    for (let j = 0; j < batch.length; j++) {
      const task = batch[j];
      const outcome = settled[j];
      completed++;

      if (task.type === 'doh') {
        if (outcome.status === 'fulfilled') {
          dohResult = outcome.value;
          send('doh_result', dohResult);
        } else {
          dohResult = { found: false, origin: 'DOH', isDOHDirect: true, error: outcome.reason?.message };
          send('doh_result', dohResult);
        }
      } else {
        let result;
        if (outcome.status === 'fulfilled') {
          result = outcome.value;
          originResults.set(task.origin, result);
        } else {
          result = { origin: task.origin, found: false, error: outcome.reason?.message };
          originResults.set(task.origin, result);
        }
        send('result', {
          origin: task.origin, index: task.index, total: totalSearches,
          ...result
        });
      }

      // Update progress bar
      const pct = Math.round((completed / totalSearches) * 100);
      send('progress', {
        origin: task.origin, index: completed, total: totalSearches,
        status: 'done', detail: `Completed (${completed}/${totalSearches})`
      });
    }
  }

  // ── RETRY PHASE: Retry failed searches once ──
  const failedOrigins = [];
  for (const [origin, result] of originResults) {
    if (!result.found || !result.cheapestUSD) {
      failedOrigins.push(origin);
    }
  }
  const dohFailed = dohResult && (!dohResult.found || !dohResult.cheapestUSD);

  if (failedOrigins.length > 0 || dohFailed) {
    const retryTotal = failedOrigins.length + (dohFailed ? 1 : 0);
    send('retry_start', { failedOrigins, dohFailed, retryTotal });
    console.log(`[RETRY] Retrying ${retryTotal} failed searches: ${failedOrigins.join(', ')}${dohFailed ? ' + DOH' : ''}`);

    // Retry DOH if failed
    if (dohFailed) {
      send('retry_progress', { origin: 'DOH', isDOHDirect: true });
      try {
        const retryResult = await searchDOHDirect(destCode, depart, returnDate, (progress) => {
          send('retry_progress', { origin: 'DOH', detail: progress.message, isDOHDirect: true });
        });
        if (retryResult && retryResult.found && retryResult.cheapestUSD) {
          dohResult = retryResult;
          console.log(`[RETRY] DOH succeeded on retry`);
        }
        send('doh_result', dohResult);
      } catch (err) {
        console.log(`[RETRY] DOH still failed: ${err.message}`);
      }
    }

    // Retry failed origins in batches
    const retryBatchSize = MAX_PARALLEL > 0 ? MAX_PARALLEL : failedOrigins.length;
    for (let i = 0; i < failedOrigins.length; i += retryBatchSize) {
      const batch = failedOrigins.slice(i, i + retryBatchSize);
      const retryTasks = batch.map(origin => {
        send('retry_progress', { origin });
        return searchFlight(origin, destCode, depart, returnDate, (progress) => {
          send('retry_progress', { origin, detail: progress.message });
        }).then(result => ({ origin, result }))
          .catch(err => ({ origin, result: { origin, found: false, error: err.message } }));
      });

      const retryResults = await Promise.all(retryTasks);
      for (const { origin, result } of retryResults) {
        if (result && result.found && result.cheapestUSD) {
          originResults.set(origin, result);
          console.log(`[RETRY] ${origin} succeeded: $${result.cheapestUSD}`);
        } else {
          console.log(`[RETRY] ${origin} still no flights`);
        }
        send('result', { origin, ...result, isRetry: true });
      }
    }
  }

  // Sort by USD price
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
  res.json({ status: 'ok', defaultOrigins: DEFAULT_ORIGINS, maxParallel: MAX_PARALLEL || 'unlimited' });
});

app.listen(PORT, () => {
  console.log(`QR Flight Search running on http://localhost:${PORT}`);
  console.log(`Default origins: ${DEFAULT_ORIGINS.join(', ')}`);
  console.log(`Parallel: ${MAX_PARALLEL > 0 ? MAX_PARALLEL : 'all at once'}`);
  console.log('Airline: Qatar Airways | Cabin: Business | Routing: O:QR+ X:DOH');
});
