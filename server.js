require('dotenv').config();

const express = require('express');
const path = require('path');
const { searchFlight, searchDOHDirect } = require('./matrix_engine');
const { resolveAirport } = require('./airports');

const app = express();
const PORT = process.env.PORT || 3000;

// MAX_PARALLEL: cap on simultaneous origin lanes (browsers).
// 0 = one lane per origin, all simultaneous (default for local).
// Set to 2 on a 512MB VPS to limit total browser count.
const MAX_PARALLEL_RAW = parseInt(process.env.MAX_PARALLEL, 10);
const MAX_PARALLEL = Number.isInteger(MAX_PARALLEL_RAW) && MAX_PARALLEL_RAW > 0 ? MAX_PARALLEL_RAW : 0;

// PAIRS_PARALLEL_PER_LANE: how many date pairs run simultaneously within each origin lane.
// Default: 2 (two browsers per origin at once — doubles speed vs 1).
// Set to 1 on low-RAM servers (512MB VPS).
const PAIRS_PARALLEL_RAW = parseInt(process.env.PAIRS_PARALLEL_PER_LANE, 10);
const PAIRS_PARALLEL_PER_LANE = Number.isInteger(PAIRS_PARALLEL_RAW) && PAIRS_PARALLEL_RAW > 0
  ? PAIRS_PARALLEL_RAW : 2;

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const DEFAULT_ORIGINS = ['DMM', 'BAH', 'RUH', 'DXB', 'AUH', 'KWI', 'MCT'];

function isValidAirportCode(code) { return /^[A-Z]{3}$/.test(code); }
function isValidDate(str) { return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(new Date(str).getTime()); }

/** Add N days to a YYYY-MM-DD string. Returns YYYY-MM-DD. */
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

/** Absolute day difference between two YYYY-MM-DD strings. */
function dayDiff(a, b) {
  return Math.abs((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000);
}

/**
 * Among a list of {depart, return} date pairs all at the same price,
 * return the one closest to the user's originally chosen dates.
 * Closest = minimum total shift (|departShift| + |returnShift|).
 */
function closestToOriginal(pairs, originalDepart, originalReturn) {
  return pairs.reduce((best, pair) => {
    const shift = dayDiff(pair.depart, originalDepart) + dayDiff(pair.return, originalReturn);
    const bestShift = dayDiff(best.depart, originalDepart) + dayDiff(best.return, originalReturn);
    return shift < bestShift ? pair : best;
  });
}

/**
 * Build full grid of {depart, return} date pairs.
 * flexDays=0 → original pair only (v2 behaviour).
 * flexDays=N → every depart±N × return±N combo, invalid pairs filtered.
 */
function buildDateGrid(departDate, returnDate, flexDays) {
  if (flexDays === 0) return [{ depart: departDate, return: returnDate }];
  const pairs = [];
  for (let d = -flexDays; d <= flexDays; d++) {
    for (let r = -flexDays; r <= flexDays; r++) {
      const dep = addDays(departDate, d);
      const ret = addDays(returnDate, r);
      if (new Date(ret) > new Date(dep)) pairs.push({ depart: dep, return: ret });
    }
  }
  return pairs;
}

/**
 * Lane-level semaphore: run pairs within a lane PAIRS_PARALLEL_PER_LANE at a time.
 * taskFns: array of () => Promise<result>
 * Returns array of results in original order.
 */
async function runPairBatch(taskFns, parallelCount) {
  if (parallelCount >= taskFns.length) {
    return Promise.all(taskFns.map(fn => fn()));
  }
  const results = new Array(taskFns.length);
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < taskFns.length) {
      const i = nextIdx++;
      results[i] = await taskFns[i]();
    }
  }
  await Promise.all(Array.from({ length: parallelCount }, () => worker()));
  return results;
}

/**
 * Global-level semaphore: cap how many origin lanes run simultaneously.
 * maxConcurrent=0 means no cap.
 */
async function runWithSemaphore(laneFns, maxConcurrent) {
  if (maxConcurrent === 0 || maxConcurrent >= laneFns.length) {
    return Promise.all(laneFns.map(fn => fn()));
  }
  const results = new Array(laneFns.length);
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < laneFns.length) {
      const i = nextIdx++;
      results[i] = await laneFns[i]();
    }
  }
  await Promise.all(Array.from({ length: maxConcurrent }, () => worker()));
  return results;
}

app.get('/api/resolve', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ resolved: null });
  res.json({ resolved: resolveAirport(q) });
});

app.get('/api/search', async (req, res) => {
  const { destination, depart, returnDate, origins, flexDays: flexDaysRaw } = req.query;

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

  const flexDays = [0, 1, 2, 3].includes(parseInt(flexDaysRaw, 10)) ? parseInt(flexDaysRaw, 10) : 0;

  const resolved = resolveAirport(destination);
  const destCode = resolved ? resolved.code : destination.toUpperCase().slice(0, 3);
  const destLabel = resolved ? resolved.label : destCode;

  if (!isValidAirportCode(destCode)) {
    return res.status(400).json({ error: `Cannot resolve destination: ${destination}` });
  }

  const rawOrigins = origins
    ? origins.split(',').map(o => o.trim().toUpperCase().slice(0, 3))
    : DEFAULT_ORIGINS;
  const originList = rawOrigins.filter(isValidAirportCode);
  if (originList.length === 0) {
    return res.status(400).json({ error: 'No valid origin airport codes provided.' });
  }

  const datePairs = buildDateGrid(depart, returnDate, flexDays);
  const pairsPerOrigin = datePairs.length;
  // Total = (origins + DOH) × pairs per origin
  const totalSearches = (originList.length + 1) * pairsPerOrigin;

  console.log(`[v3.2] dest=${destCode} origins=${originList.length}+DOH flexDays=${flexDays} pairs=${pairsPerOrigin} pairsParallel=${PAIRS_PARALLEL_PER_LANE} total=${totalSearches}`);

  // SSE setup
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  let clientConnected = true;
  req.on('close', () => { clientConnected = false; console.log('[SSE] Client disconnected'); });

  const send = (event, data) => {
    if (!clientConnected) return;
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch (_) { clientConnected = false; }
  };

  // Global completed counter — incremented by every lane after each pair finishes
  let globalCompleted = 0;
  function completedOne() {
    globalCompleted++;
    send('counter', { completed: globalCompleted, total: totalSearches });
  }

  send('info', {
    destination: destCode, destinationLabel: destLabel,
    depart, returnDate, origins: originList,
    totalSearches, flexDays, pairsPerOrigin,
    pairsParallelPerLane: PAIRS_PARALLEL_PER_LANE,
    airline: 'Qatar Airways', cabin: 'Business', routing: 'Via DOH'
  });

  // ── Origin Lane ───────────────────────────────────────────────────────────
  async function runOriginLane(origin, pairs) {
    let bestUSD = null;
    let tiedDates = [];    // all date pairs at the current best price
    const erroredPairs = [];

    send('flex_progress', { origin, status: 'lane_start', totalPairs: pairs.length });

    // Run pairs in sub-batches of PAIRS_PARALLEL_PER_LANE
    const pairTaskFns = pairs.map((pair, p) => async () => {
      if (!clientConnected) return;

      send('flex_progress', {
        origin, status: 'searching',
        depart: pair.depart, return: pair.return,
        pairIndex: p, totalPairs: pairs.length
      });

      let result = null;
      try {
        result = await searchFlight(
          origin, destCode, pair.depart, pair.return,
          (prog) => send('flex_progress', {
            origin, status: 'searching',
            depart: pair.depart, return: pair.return,
            pairIndex: p, totalPairs: pairs.length,
            detail: prog.message
          })
        );
      } catch (err) {
        console.error(`[${origin}] ${pair.depart}/${pair.return}: ${err.message}`);
        erroredPairs.push(pair);
        completedOne();
        send('flex_progress', { origin, status: 'pair_done', pairIndex: p, totalPairs: pairs.length });
        return;
      }

      if (result.error) {
        erroredPairs.push(pair);
      } else if (result.found && result.cheapestUSD) {
        const usd = result.cheapestUSD;
        if (bestUSD === null || usd < bestUSD) {
          // New cheapest — reset tied list
          bestUSD = usd;
          tiedDates = [{ depart: pair.depart, return: pair.return, result }];
          send('flex_best', {
            origin, cheapestUSD: usd,
            cheapestQAR: result.cheapestQAR,
            cheapestLocal: result.cheapestLocal,
            winningDepart: pair.depart,
            winningReturn: pair.return,
            tiedCount: 1
          });
        } else if (usd === bestUSD) {
          // Tied price — add to list
          tiedDates.push({ depart: pair.depart, return: pair.return, result });
          send('flex_best', {
            origin, cheapestUSD: usd,
            cheapestQAR: result.cheapestQAR,
            cheapestLocal: result.cheapestLocal,
            winningDepart: tiedDates[0].depart,
            winningReturn: tiedDates[0].return,
            tiedCount: tiedDates.length
          });
        }
      }

      completedOne();
      send('flex_progress', {
        origin, status: 'pair_done',
        depart: pair.depart, return: pair.return,
        pairIndex: p, totalPairs: pairs.length,
        bestSoFar: bestUSD
      });
    });

    await runPairBatch(pairTaskFns, PAIRS_PARALLEL_PER_LANE);

    // Retry errored pairs once — only if we have no successful result yet
    if (erroredPairs.length > 0 && bestUSD === null) {
      console.log(`[${origin}] Retrying ${erroredPairs.length} errored pairs`);
      send('flex_progress', { origin, status: 'retrying', retryCount: erroredPairs.length });
      for (const pair of erroredPairs) {
        if (!clientConnected) break;
        try {
          const result = await searchFlight(
            origin, destCode, pair.depart, pair.return,
            (prog) => send('flex_progress', { origin, status: 'retrying', detail: prog.message })
          );
          if (result.found && result.cheapestUSD) {
            const usd = result.cheapestUSD;
            if (bestUSD === null || usd < bestUSD) {
              bestUSD = usd;
              tiedDates = [{ depart: pair.depart, return: pair.return, result }];
              send('flex_best', {
                origin, cheapestUSD: usd,
                cheapestQAR: result.cheapestQAR,
                cheapestLocal: result.cheapestLocal,
                winningDepart: pair.depart,
                winningReturn: pair.return,
                tiedCount: 1, isRetry: true
              });
            } else if (usd === bestUSD) {
              tiedDates.push({ depart: pair.depart, return: pair.return, result });
            }
          }
        } catch (_) {}
        completedOne();
      }
    }

    // Pick headline date: closest to user's original dates among all tied
    let headline = null;
    let allTiedDatePairs = [];
    if (tiedDates.length > 0) {
      allTiedDatePairs = tiedDates.map(t => ({ depart: t.depart, return: t.return }));
      const headlinePair = closestToOriginal(allTiedDatePairs, depart, returnDate);
      const headlineData = tiedDates.find(t => t.depart === headlinePair.depart && t.return === headlinePair.return);
      headline = {
        ...headlineData.result,
        winningDepart: headlinePair.depart,
        winningReturn: headlinePair.return,
        tiedDates: allTiedDatePairs
      };
    }

    send('flex_progress', {
      origin, status: 'lane_done',
      found: headline !== null,
      cheapestUSD: bestUSD
    });

    return headline || { origin, found: false, winningDepart: depart, winningReturn: returnDate, tiedDates: [] };
  }

  // ── DOH Lane ─────────────────────────────────────────────────────────────
  async function runDOHLane(pairs) {
    let bestUSD = null;
    let tiedDates = [];
    const erroredPairs = [];

    send('flex_progress', { origin: 'DOH', status: 'lane_start', totalPairs: pairs.length, isDOHDirect: true });

    const pairTaskFns = pairs.map((pair, p) => async () => {
      if (!clientConnected) return;

      send('flex_progress', {
        origin: 'DOH', status: 'searching', isDOHDirect: true,
        depart: pair.depart, return: pair.return,
        pairIndex: p, totalPairs: pairs.length
      });

      let result = null;
      try {
        result = await searchDOHDirect(
          destCode, pair.depart, pair.return,
          (prog) => send('flex_progress', {
            origin: 'DOH', status: 'searching', isDOHDirect: true,
            depart: pair.depart, return: pair.return,
            pairIndex: p, totalPairs: pairs.length,
            detail: prog.message
          })
        );
      } catch (err) {
        console.error(`[DOH] ${pair.depart}/${pair.return}: ${err.message}`);
        erroredPairs.push(pair);
        completedOne();
        send('flex_progress', { origin: 'DOH', status: 'pair_done', pairIndex: p, totalPairs: pairs.length, isDOHDirect: true });
        return;
      }

      if (result.error) {
        erroredPairs.push(pair);
      } else if (result.found && result.cheapestUSD) {
        const usd = result.cheapestUSD;
        if (bestUSD === null || usd < bestUSD) {
          bestUSD = usd;
          tiedDates = [{ depart: pair.depart, return: pair.return, result }];
          send('doh_result', { ...result, isDOHDirect: true, winningDepart: pair.depart, winningReturn: pair.return });
        } else if (usd === bestUSD) {
          tiedDates.push({ depart: pair.depart, return: pair.return, result });
        }
      }

      completedOne();
      send('flex_progress', {
        origin: 'DOH', status: 'pair_done', isDOHDirect: true,
        depart: pair.depart, return: pair.return,
        pairIndex: p, totalPairs: pairs.length
      });
    });

    await runPairBatch(pairTaskFns, PAIRS_PARALLEL_PER_LANE);

    // Retry DOH errored pairs
    if (erroredPairs.length > 0 && bestUSD === null) {
      send('flex_progress', { origin: 'DOH', status: 'retrying', isDOHDirect: true });
      for (const pair of erroredPairs) {
        if (!clientConnected) break;
        try {
          const result = await searchDOHDirect(
            destCode, pair.depart, pair.return,
            (prog) => send('flex_progress', { origin: 'DOH', status: 'retrying', detail: prog.message, isDOHDirect: true })
          );
          if (result.found && result.cheapestUSD) {
            const usd = result.cheapestUSD;
            if (bestUSD === null || usd < bestUSD) {
              bestUSD = usd;
              tiedDates = [{ depart: pair.depart, return: pair.return, result }];
              send('doh_result', { ...result, isDOHDirect: true, winningDepart: pair.depart, winningReturn: pair.return });
            } else if (usd === bestUSD) {
              tiedDates.push({ depart: pair.depart, return: pair.return, result });
            }
          }
        } catch (_) {}
        completedOne();
      }
    }

    // Pick headline DOH date: closest to original
    let headline = null;
    if (tiedDates.length > 0) {
      const allTiedDatePairs = tiedDates.map(t => ({ depart: t.depart, return: t.return }));
      const headlinePair = closestToOriginal(allTiedDatePairs, depart, returnDate);
      const headlineData = tiedDates.find(t => t.depart === headlinePair.depart && t.return === headlinePair.return);
      headline = {
        ...headlineData.result,
        isDOHDirect: true,
        winningDepart: headlinePair.depart,
        winningReturn: headlinePair.return,
        tiedDates: allTiedDatePairs
      };
    }

    send('flex_progress', {
      origin: 'DOH', status: 'lane_done', isDOHDirect: true,
      found: headline !== null,
      cheapestUSD: bestUSD
    });

    return headline || { origin: 'DOH', found: false, isDOHDirect: true, winningDepart: depart, winningReturn: returnDate, tiedDates: [] };
  }

  // ── Run all lanes simultaneously ──────────────────────────────────────────
  const laneFns = [
    () => runDOHLane(datePairs),
    ...originList.map(origin => () => runOriginLane(origin, datePairs))
  ];

  const allResults = await runWithSemaphore(laneFns, MAX_PARALLEL);

  if (!clientConnected) { res.end(); return; }

  const dohResult = allResults[0];
  const originResults = allResults.slice(1);

  const validResults = originResults
    .filter(r => r && r.found && r.cheapestUSD)
    .sort((a, b) => a.cheapestUSD - b.cheapestUSD);

  send('done', {
    results: validResults,
    winner: validResults.length > 0 ? validResults[0] : null,
    dohDirect: dohResult,
    totalSearched: originList.length,
    totalFound: validResults.length,
    flexDays,
    originalDepart: depart,
    originalReturn: returnDate
  });

  res.end();
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', version: '3.2',
    defaultOrigins: DEFAULT_ORIGINS,
    maxParallel: MAX_PARALLEL || 'one-per-origin',
    pairsParallelPerLane: PAIRS_PARALLEL_PER_LANE
  });
});

app.listen(PORT, () => {
  console.log(`QR Flight Search v3.2 running on http://localhost:${PORT}`);
  console.log(`Default origins: ${DEFAULT_ORIGINS.join(', ')}`);
  console.log(`Lanes: ${MAX_PARALLEL > 0 ? `max ${MAX_PARALLEL}` : 'one per origin (all simultaneous)'}`);
  console.log(`Pairs per lane: ${PAIRS_PARALLEL_PER_LANE} simultaneous`);
  console.log('Airline: Qatar Airways | Cabin: Business | Routing: O:QR+ X:DOH');
});
