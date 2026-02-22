const { chromium } = require('playwright');

// Exchange rates to USD (approximate — update periodically)
// Last updated: 2026-02
const EXCHANGE_RATES = {
  SAR: 0.267,   // Saudi Riyal
  BHD: 2.65,    // Bahraini Dinar
  AED: 0.272,   // UAE Dirham
  QAR: 0.275,   // Qatari Riyal
  KWD: 3.26,    // Kuwaiti Dinar
  OMR: 2.60,    // Omani Rial
  USD: 1.0,
  EUR: 1.08,
  GBP: 1.27
};

const CURRENCY_PATTERN = Object.keys(EXCHANGE_RATES).join('|');

function toUSD(amount, currency) {
  const rate = EXCHANGE_RATES[currency] || 1;
  return parseFloat((amount * rate).toFixed(2));
}

// toQAR: USD -> QAR via consistent EXCHANGE_RATES
function toQAR(usdAmount) {
  return parseFloat((usdAmount / EXCHANGE_RATES.QAR).toFixed(2));
}

/**
 * Parse ITA Matrix results page text into structured flight data.
 * Each flight block starts with a price line, followed by airline, times, durations, routes, stops.
 */
function parseResultRows(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];

  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const flights = [];

  // Find where results start — after the "Advisory" header line
  let startIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'Advisory') { startIdx = i + 1; break; }
  }

  // Find where results end
  let endIdx = lines.length;
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].includes('Items per page') || lines[i].includes('About')) {
      endIdx = i; break;
    }
  }

  const resultLines = lines.slice(startIdx, endIdx);
  const priceRegex = new RegExp(`^(${CURRENCY_PATTERN})\\s([\\d,]+)$`);

  let currentFlight = null;

  for (const line of resultLines) {
    const priceMatch = line.match(priceRegex);

    if (priceMatch) {
      if (currentFlight) flights.push(currentFlight);
      const currency = priceMatch[1];
      const amount = parseFloat(priceMatch[2].replace(/,/g, ''));
      const usd = toUSD(amount, currency);
      currentFlight = {
        price: { currency, amount, usd, qar: toQAR(usd) },
        airline: '',
        departTimes: [],
        arriveTimes: [],
        durations: [],
        routes: [],
        stops: []
      };
      continue;
    }

    if (!currentFlight) continue;

    if (line.includes('Qatar Airways') || line.includes('Royal Air Maroc')) {
      currentFlight.airline = line; continue;
    }

    // Time: "5:00 AM" or "7:30 AM(06-06)"
    if (/^\d{1,2}:\d{2}\s?(?:AM|PM)(\(\d{2}-\d{2}\))?$/.test(line)) {
      if (currentFlight.departTimes.length < 2 && currentFlight.arriveTimes.length === 0) {
        currentFlight.departTimes.push(line);
      } else {
        currentFlight.arriveTimes.push(line);
      }
      continue;
    }

    // Duration: "11h 0m"
    if (/^\d+h\s?\d+m$/.test(line)) { currentFlight.durations.push(line); continue; }

    // Route: "DMM to CMN"
    if (line.includes(' to ') && line.length < 30) { currentFlight.routes.push(line); continue; }

    // Stop: any 3-letter uppercase airport code
    if (/^[A-Z]{3}$/.test(line)) { currentFlight.stops.push(line); continue; }
  }

  if (currentFlight) flights.push(currentFlight);

  return flights
    .filter(f => f.airline.includes('Qatar Airways') && !f.airline.includes('Royal Air Maroc'))
    .map(f => ({
      price: f.price,
      airline: 'Qatar Airways',
      outbound: {
        depart: f.departTimes[0] || '',
        arrive: f.arriveTimes[0] || '',
        duration: f.durations[0] || '',
        route: f.routes[0] || '',
        stop: f.stops[0] || 'DOH'
      },
      inbound: {
        depart: f.departTimes[1] || '',
        arrive: f.arriveTimes[1] || '',
        duration: f.durations[1] || '',
        route: f.routes[1] || '',
        stop: f.stops[1] || 'DOH'
      }
    }));
}

/**
 * Navigate the ITA Matrix date calendar to select depart + return dates.
 * Handles cross-year boundaries correctly.
 */
async function selectDates(page, departDate, returnDate) {
  await page.locator('mat-date-range-input').click();
  await page.waitForTimeout(2000);
  await page.waitForSelector('mat-calendar', { timeout: 5000 });

  const depart = new Date(departDate + 'T00:00:00');
  const ret = new Date(returnDate + 'T00:00:00');
  const now = new Date();

  // Navigate to departure month
  let monthsToAdvance = (depart.getFullYear() - now.getFullYear()) * 12 + (depart.getMonth() - now.getMonth());
  if (monthsToAdvance < 0) monthsToAdvance = 0;
  for (let i = 0; i < monthsToAdvance; i++) {
    const nextBtn = page.locator('button[aria-label*="Next"]').first();
    if (await nextBtn.count() > 0) { await nextBtn.click(); await page.waitForTimeout(400); }
  }

  // Click departure day
  const days1 = await page.locator('.mat-calendar-body-cell:not(.mat-calendar-body-disabled)').all();
  if (days1.length >= depart.getDate()) await days1[depart.getDate() - 1].click();
  await page.waitForTimeout(500);

  // Navigate from departure month to return month (handles cross-year correctly)
  const monthsDiff = (ret.getFullYear() - depart.getFullYear()) * 12 + (ret.getMonth() - depart.getMonth());
  for (let i = 0; i < monthsDiff; i++) {
    const nextBtn = page.locator('button[aria-label*="Next"]').first();
    if (await nextBtn.count() > 0) { await nextBtn.click(); await page.waitForTimeout(400); }
  }

  // Click return day
  const days2 = await page.locator('.mat-calendar-body-cell:not(.mat-calendar-body-disabled)').all();
  if (days2.length >= ret.getDate()) await days2[ret.getDate() - 1].click();
  await page.waitForTimeout(1000);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
}

/**
 * Wait for ITA Matrix results to appear (polls DOM instead of blind sleep).
 * Returns page text once a price is detected or timeout is reached.
 */
async function waitForResults(page, maxWait = 60000, pollInterval = 2000) {
  const priceRegex = new RegExp(`(${CURRENCY_PATTERN})\\s[\\d,]+`);
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const text = await page.evaluate(() => document.body.innerText);
    if (priceRegex.test(text) && text.includes('Advisory')) return text;
    await page.waitForTimeout(pollInterval);
  }
  // Return whatever is on the page after timeout
  return page.evaluate(() => document.body.innerText);
}

/**
 * Launch a Chromium browser with standard hardened options.
 */
async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',            // Required when running as root on Linux
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // Prevents crashes in low-memory environments
      '--disable-gpu',
      '--no-zygote'
    ]
  });
}

/**
 * Create a browser page with user-agent + viewport set to avoid bot fingerprinting.
 */
async function newPage(browser) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'America/New_York'
  });
  return context.newPage();
}

/**
 * Core ITA Matrix search — shared by searchFlight and searchDOHDirect.
 * @param {string} origin       - IATA origin code
 * @param {string} destination  - IATA destination code
 * @param {string} departDate   - YYYY-MM-DD
 * @param {string} returnDate   - YYYY-MM-DD
 * @param {function} onProgress - progress callback({ origin, message })
 * @param {object} options
 * @param {boolean} options.isDOHDirect - true = O:QR+ routing, false = O:QR+ X:DOH
 */
async function runSearch(origin, destination, departDate, returnDate, onProgress, options = {}) {
  const { isDOHDirect = false } = options;
  const label = isDOHDirect ? 'DOH-DIRECT' : origin;

  const log = (msg) => {
    console.log(`[${label}] ${msg}`);
    if (onProgress) {
      try { onProgress({ origin, message: msg }); } catch (_) {}
    }
  };

  let browser = null;
  try {
    log('Launching browser...');
    browser = await launchBrowser();
    const page = await newPage(browser);

    log('Opening ITA Matrix...');
    await page.goto('https://matrix.itasoftware.com/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(8000);

    // === ORIGIN ===
    log(`Setting origin ${origin}...`);
    const originInput = page.locator('input[placeholder="Add airport"]').first();
    await originInput.click();
    await page.waitForTimeout(500);
    await originInput.type(origin);
    await page.waitForTimeout(2000);
    await page.waitForSelector('mat-option', { timeout: 5000 });
    await page.locator('mat-option').filter({ hasText: origin }).first().click();
    await page.waitForTimeout(1000);

    // === DESTINATION ===
    log(`Setting destination ${destination}...`);
    const destInput = page.locator('input[placeholder="Add airport"]').nth(1);
    await destInput.click();
    await page.waitForTimeout(500);
    await destInput.type(destination);
    await page.waitForTimeout(2000);
    await page.waitForSelector('mat-option', { timeout: 5000 });
    await page.locator('mat-option').filter({ hasText: destination }).first().click();
    await page.waitForTimeout(1000);

    // === DATES ===
    log('Setting dates...');
    await selectDates(page, departDate, returnDate);
    const datesText = await page.evaluate(() => {
      const range = document.querySelector('mat-date-range-input');
      return range ? range.textContent.trim() : '';
    });
    log(`Dates set: ${datesText}`);

    // === ADVANCED CONTROLS ===
    const advancedLink = page.getByText('Show Advanced Controls').first();
    if (await advancedLink.count() > 0) {
      await advancedLink.click();
      await page.waitForTimeout(1500);
    }

    // === ROUTING ===
    // isDOHDirect: O:QR+ only (DOH is origin, not a connection point)
    // standard:    O:QR+ X:DOH (must connect via DOH)
    const routing = isDOHDirect ? 'O:QR+' : 'O:QR+ X:DOH';
    const routingInputs = await page.locator('input[placeholder="Routing"]').all();
    if (routingInputs.length >= 2) {
      await routingInputs[0].fill(routing);
      await routingInputs[1].fill(routing);
    }
    log(`Routing: ${routing}`);

    // === CABIN ===
    await page.locator('text=Cabin').click();
    await page.waitForTimeout(500);
    await page.locator('mat-option').filter({ hasText: 'Business' }).first().click();
    await page.waitForTimeout(500);
    log('Cabin: Business');

    // === SUBMIT & WAIT FOR RESULTS ===
    log('Submitting search...');
    await page.locator('button.search-button').click();

    log('Waiting for results...');
    const finalText = await waitForResults(page);

    // Use parser to extract results — avoids greedy regex matching wrong page text
    const flights = parseResultRows(finalText);

    if (flights.length === 0) {
      log('No Qatar Airways Business Class flights found');
      return {
        origin, destination, departDate, returnDate, isDOHDirect,
        found: false, cheapestLocal: null, cheapestUSD: null, cheapestQAR: null,
        flights: [], qrOnly: true
      };
    }

    const cheapest = flights[0].price;
    log(`Cheapest: ${cheapest.currency} ${cheapest.amount.toLocaleString('en-US')} (~$${cheapest.usd} USD / ~QAR ${cheapest.qar})`);

    return {
      origin, destination, departDate, returnDate, isDOHDirect,
      found: true,
      cheapestLocal: { currency: cheapest.currency, amount: cheapest.amount },
      cheapestUSD: cheapest.usd,
      cheapestQAR: cheapest.qar,
      flights,
      qrOnly: true,
      resultCount: flights.length
    };

  } catch (error) {
    log(`Error: ${error.message}`);
    return {
      origin, destination, departDate, returnDate, isDOHDirect,
      found: false, error: error.message,
      cheapestLocal: null, cheapestUSD: null, cheapestQAR: null,
      flights: []
    };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Search ITA Matrix for origin -> destination round trip via DOH.
 */
async function searchFlight(origin, destination, departDate, returnDate, onProgress) {
  return runSearch(origin, destination, departDate, returnDate, onProgress, { isDOHDirect: false });
}

/**
 * Search DOH -> destination non-stop on Qatar Airways (benchmark comparison).
 */
async function searchDOHDirect(destination, departDate, returnDate, onProgress) {
  return runSearch('DOH', destination, departDate, returnDate, onProgress, { isDOHDirect: true });
}

module.exports = { searchFlight, searchDOHDirect, EXCHANGE_RATES, toUSD, toQAR };
