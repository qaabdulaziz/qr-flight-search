const { chromium } = require('playwright');

// Exchange rates to USD (approximate)
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

// Reverse: USD to other currencies
const USD_TO = {
  QAR: 1 / 0.275
};

function toUSD(amount, currency) {
  const rate = EXCHANGE_RATES[currency] || 1;
  return parseFloat((amount * rate).toFixed(2));
}

function toQAR(usdAmount) {
  return parseFloat((usdAmount * USD_TO.QAR).toFixed(2));
}

/**
 * Parse the results page text into structured flight data.
 * ITA Matrix results come as tab-separated rows with this pattern:
 *   PRICE \t AIRLINE \t DEPART_TIMES \t ARRIVE_TIMES \t DURATIONS \t ROUTES \t STOPS \t ADVISORY
 */
function parseResultsText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const flights = [];

  for (let i = 0; i < lines.length; i++) {
    // Match price lines: "SAR 7,104" or "BHD 560" etc at start of a result row
    const priceMatch = lines[i].match(/^(SAR|BHD|AED|QAR|KWD|OMR|USD|EUR|GBP)\s([\d,]+)$/);
    if (!priceMatch) continue;

    const currency = priceMatch[1];
    const amount = parseFloat(priceMatch[2].replace(/,/g, ''));
    const usd = toUSD(amount, currency);
    const qar = toQAR(usd);

    // Next line should be airline
    const airline = (i + 1 < lines.length) ? lines[i + 1] : '';

    // Skip non-Qatar Airways operated (Royal Air Maroc etc)
    if (!airline.includes('Qatar Airways') || airline.includes('Royal Air Maroc')) {
      continue;
    }

    // Collect the next ~10 lines to extract times/durations/stops
    const block = lines.slice(i + 1, i + 15);

    // Extract departure times (e.g. "4:30 PM" and "8:50 PM")
    const times = [];
    const timeRegex = /^\d{1,2}:\d{2}\s?(AM|PM)(\(\d{2}-\d{2}\))?$/;
    for (const line of block) {
      if (timeRegex.test(line)) {
        times.push(line);
      }
    }

    // Extract arrive times (with optional date like "7:30 AM(04-05)")
    const arriveRegex = /^\d{1,2}:\d{2}\s?(AM|PM)(\(\d{2}-\d{2}\))?$/;
    const arrivals = [];
    for (const line of block) {
      if (arriveRegex.test(line)) {
        arrivals.push(line);
      }
    }

    // Extract durations (e.g. "11h 0m")
    const durations = [];
    const durRegex = /^\d+h\s?\d+m$/;
    for (const line of block) {
      if (durRegex.test(line)) {
        durations.push(line);
      }
    }

    // Extract routes (e.g. "DMM to CMN")
    const routes = [];
    for (const line of block) {
      if (line.includes(' to ') && line.length < 30) {
        routes.push(line);
      }
    }

    // Extract stops
    const stops = [];
    for (const line of block) {
      if (line === 'DOH') {
        stops.push('DOH');
      }
    }

    // Build structured flight
    // times[0] = outbound depart, times[1] = return depart
    // arrivals come after depart times (index 2, 3)
    const flight = {
      price: { currency, amount, usd, qar },
      airline: 'Qatar Airways',
      outbound: {
        depart: times[0] || '',
        arrive: times[2] || arrivals[2] || '',
        duration: durations[0] || '',
        route: routes[0] || '',
        stop: stops[0] || 'DOH'
      },
      return: {
        depart: times[1] || '',
        arrive: times[3] || arrivals[3] || '',
        duration: durations[1] || '',
        route: routes[1] || '',
        stop: stops[1] || 'DOH'
      }
    };

    flights.push(flight);
  }

  return flights;
}

/**
 * Better approach: scrape the raw result text and parse each row as a unit.
 * ITA Matrix rows look like:
 *   SAR 7,104 | Qatar Airways | 5:00 AM\n8:50 PM | 1:50 PM\n9:20 AM(06-16) | 10h 50m\n10h 30m | DMM to CMN\nCMN to DMM | DOH\nDOH
 */
function parseResultRows(rawText) {
  // Split into lines
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const flights = [];

  // Find where results start - after the table headers
  let startIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'Advisory') {
      startIdx = i + 1;
      break;
    }
  }

  // Find where results end
  let endIdx = lines.length;
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].includes('Items per page') || lines[i].includes('About')) {
      endIdx = i;
      break;
    }
  }

  const resultLines = lines.slice(startIdx, endIdx);

  // Each flight block starts with a price line
  let currentFlight = null;
  let fieldIndex = 0;

  for (let i = 0; i < resultLines.length; i++) {
    const line = resultLines[i];
    const priceMatch = line.match(/^(SAR|BHD|AED|QAR|KWD|OMR|USD|EUR|GBP)\s([\d,]+)$/);

    if (priceMatch) {
      // Save previous flight
      if (currentFlight) flights.push(currentFlight);

      const currency = priceMatch[1];
      const amount = parseFloat(priceMatch[2].replace(/,/g, ''));
      const usd = toUSD(amount, currency);
      const qar = toQAR(usd);

      currentFlight = {
        price: { currency, amount, usd, qar },
        airline: '',
        departTimes: [],
        arriveTimes: [],
        durations: [],
        routes: [],
        stops: []
      };
      fieldIndex = 0;
      continue;
    }

    if (!currentFlight) continue;

    // Airline name
    if (line.includes('Qatar Airways') || line.includes('Royal Air Maroc')) {
      currentFlight.airline = line;
      continue;
    }

    // Time pattern: "5:00 AM" or "7:30 AM(06-06)"
    const timeMatch = line.match(/^(\d{1,2}:\d{2}\s?(?:AM|PM))(\(\d{2}-\d{2}\))?$/);
    if (timeMatch) {
      if (currentFlight.departTimes.length < 2 && currentFlight.arriveTimes.length === 0) {
        currentFlight.departTimes.push(line);
      } else {
        currentFlight.arriveTimes.push(line);
      }
      continue;
    }

    // Duration: "11h 0m"
    if (/^\d+h\s?\d+m$/.test(line)) {
      currentFlight.durations.push(line);
      continue;
    }

    // Route: "DMM to CMN"
    if (line.includes(' to ') && line.length < 30) {
      currentFlight.routes.push(line);
      continue;
    }

    // Stop: "DOH"
    if (line === 'DOH') {
      currentFlight.stops.push(line);
      continue;
    }
  }

  // Don't forget last flight
  if (currentFlight) flights.push(currentFlight);

  // Filter to Qatar Airways only and structure
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
 * Search ITA Matrix for a single origin -> destination
 */
async function searchFlight(origin, destination, departDate, returnDate, onProgress) {
  const log = (msg) => {
    console.log(`[${origin}] ${msg}`);
    if (onProgress) onProgress({ origin, message: msg });
  };

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',           // Required when running as root on Linux
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // Prevents crashes in low-memory VPS environments
      '--disable-gpu',
      '--no-zygote'
    ]
  });
  const page = await browser.newPage();

  try {
    log('Opening ITA Matrix...');
    await page.goto('https://matrix.itasoftware.com/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(8000);

    // === ORIGIN ===
    log('Setting origin...');
    const originInput = await page.locator('input[placeholder="Add airport"]').first();
    await originInput.click();
    await page.waitForTimeout(500);
    await originInput.type(origin);
    await page.waitForTimeout(2000);

    await page.waitForSelector('mat-option', { timeout: 5000 });
    const originOption = await page.locator('mat-option').filter({ hasText: origin }).first();
    await originOption.click();
    await page.waitForTimeout(1000);

    // === DESTINATION ===
    log('Setting destination...');
    const destInput = await page.locator('input[placeholder="Add airport"]').nth(1);
    await destInput.click();
    await page.waitForTimeout(500);
    await destInput.type(destination);
    await page.waitForTimeout(2000);

    await page.waitForSelector('mat-option', { timeout: 5000 });
    const destOption = await page.locator('mat-option').filter({ hasText: destination }).first();
    await destOption.click();
    await page.waitForTimeout(1000);

    // === DATES ===
    log('Setting dates...');
    await page.locator('mat-date-range-input').click();
    await page.waitForTimeout(2000);
    await page.waitForSelector('mat-calendar', { timeout: 5000 });

    const depart = new Date(departDate + 'T00:00:00');
    const ret = new Date(returnDate + 'T00:00:00');
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const targetMonth = depart.getMonth();
    const targetYear = depart.getFullYear();

    let monthsToAdvance = (targetYear - currentYear) * 12 + (targetMonth - currentMonth);
    if (monthsToAdvance < 0) monthsToAdvance = 0;

    for (let i = 0; i < monthsToAdvance; i++) {
      const nextBtn = await page.locator('button[aria-label*="Next"]').first();
      if (await nextBtn.count() > 0) {
        await nextBtn.click();
        await page.waitForTimeout(400);
      }
    }

    const departDay = depart.getDate();
    const days1 = await page.locator('.mat-calendar-body-cell:not(.mat-calendar-body-disabled)').all();
    if (days1.length >= departDay) {
      await days1[departDay - 1].click();
    }
    await page.waitForTimeout(500);

    const returnMonth = ret.getMonth();
    if (returnMonth !== targetMonth) {
      const extraMonths = returnMonth - targetMonth;
      for (let i = 0; i < extraMonths; i++) {
        const nextBtn = await page.locator('button[aria-label*="Next"]').first();
        if (await nextBtn.count() > 0) {
          await nextBtn.click();
          await page.waitForTimeout(400);
        }
      }
    }

    const returnDay = ret.getDate();
    const days2 = await page.locator('.mat-calendar-body-cell:not(.mat-calendar-body-disabled)').all();
    if (days2.length >= returnDay) {
      await days2[returnDay - 1].click();
    }
    await page.waitForTimeout(1000);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    const datesText = await page.evaluate(() => {
      const range = document.querySelector('mat-date-range-input');
      return range ? range.textContent : '';
    });
    log(`Dates: ${datesText}`);

    // === ADVANCED CONTROLS ===
    const advancedLink = await page.$('text=Show Advanced Controls');
    if (advancedLink) {
      await advancedLink.click();
      await page.waitForTimeout(1500);
    }

    // === ROUTING CODES ===
    const routingInputs = await page.locator('input[placeholder="Routing"]').all();
    if (routingInputs.length >= 2) {
      await routingInputs[0].fill('O:QR+ X:DOH');
      await routingInputs[1].fill('O:QR+ X:DOH');
    }
    log('Routing: O:QR+ X:DOH');

    // === CABIN ===
    await page.click('text=Cabin');
    await page.waitForTimeout(500);
    const bizOption = await page.locator('mat-option').filter({ hasText: 'Business' }).first();
    await bizOption.click();
    await page.waitForTimeout(500);
    log('Cabin: Business class or higher');

    // === SUBMIT ===
    log('Searching...');
    await page.locator('button.search-button').click();
    await page.waitForTimeout(50000);

    const finalText = await page.evaluate(() => document.body.innerText);

    // Parse cheapest price
    const priceMatch = finalText.match(/(SAR|BHD|AED|QAR|KWD|OMR|USD|EUR|GBP)\s?([\d,]+)/);
    if (!priceMatch) {
      log('No flights found');
      return {
        origin, destination, departDate, returnDate,
        found: false, cheapestLocal: null, cheapestUSD: null, cheapestQAR: null,
        flights: [], qrOnly: true
      };
    }

    const currency = priceMatch[1];
    const amount = parseFloat(priceMatch[2].replace(/,/g, ''));
    const usd = toUSD(amount, currency);
    const qar = toQAR(usd);

    log(`Cheapest: ${currency} ${amount.toLocaleString()} (~$${usd} USD / ~QAR ${qar})`);

    // Parse all flights
    const flights = parseResultRows(finalText);

    return {
      origin, destination, departDate, returnDate,
      found: true,
      cheapestLocal: { currency, amount },
      cheapestUSD: usd,
      cheapestQAR: qar,
      flights,
      qrOnly: true,
      resultCount: flights.length
    };

  } catch (error) {
    log(`Error: ${error.message}`);
    return {
      origin, destination, departDate, returnDate,
      found: false, error: error.message,
      cheapestLocal: null, cheapestUSD: null, cheapestQAR: null,
      flights: []
    };
  } finally {
    await browser.close();
  }
}

/**
 * Search DOH -> destination non-stop on Qatar Airways (benchmark comparison).
 * Uses routing O:QR+ with no X:DOH constraint since DOH is the origin itself.
 */
async function searchDOHDirect(destination, departDate, returnDate, onProgress) {
  const log = (msg) => {
    console.log(`[DOH-DIRECT] ${msg}`);
    if (onProgress) onProgress({ origin: 'DOH', message: msg });
  };

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote'
    ]
  });
  const page = await browser.newPage();

  try {
    log('Opening ITA Matrix...');
    await page.goto('https://matrix.itasoftware.com/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(8000);

    // === ORIGIN: DOH ===
    log('Setting origin DOH...');
    const originInput = await page.locator('input[placeholder="Add airport"]').first();
    await originInput.click();
    await page.waitForTimeout(500);
    await originInput.type('DOH');
    await page.waitForTimeout(2000);
    await page.waitForSelector('mat-option', { timeout: 5000 });
    const originOption = await page.locator('mat-option').filter({ hasText: 'DOH' }).first();
    await originOption.click();
    await page.waitForTimeout(1000);

    // === DESTINATION ===
    log(`Setting destination ${destination}...`);
    const destInput = await page.locator('input[placeholder="Add airport"]').nth(1);
    await destInput.click();
    await page.waitForTimeout(500);
    await destInput.type(destination);
    await page.waitForTimeout(2000);
    await page.waitForSelector('mat-option', { timeout: 5000 });
    const destOption = await page.locator('mat-option').filter({ hasText: destination }).first();
    await destOption.click();
    await page.waitForTimeout(1000);

    // === DATES ===
    log('Setting dates...');
    await page.locator('mat-date-range-input').click();
    await page.waitForTimeout(2000);
    await page.waitForSelector('mat-calendar', { timeout: 5000 });

    const depart = new Date(departDate + 'T00:00:00');
    const ret = new Date(returnDate + 'T00:00:00');
    const now = new Date();
    let monthsToAdvance = (depart.getFullYear() - now.getFullYear()) * 12 + (depart.getMonth() - now.getMonth());
    if (monthsToAdvance < 0) monthsToAdvance = 0;

    for (let i = 0; i < monthsToAdvance; i++) {
      const nextBtn = await page.locator('button[aria-label*="Next"]').first();
      if (await nextBtn.count() > 0) { await nextBtn.click(); await page.waitForTimeout(400); }
    }

    const days1 = await page.locator('.mat-calendar-body-cell:not(.mat-calendar-body-disabled)').all();
    if (days1.length >= depart.getDate()) await days1[depart.getDate() - 1].click();
    await page.waitForTimeout(500);

    if (ret.getMonth() !== depart.getMonth()) {
      const extra = ret.getMonth() - depart.getMonth();
      for (let i = 0; i < extra; i++) {
        const nextBtn = await page.locator('button[aria-label*="Next"]').first();
        if (await nextBtn.count() > 0) { await nextBtn.click(); await page.waitForTimeout(400); }
      }
    }

    const days2 = await page.locator('.mat-calendar-body-cell:not(.mat-calendar-body-disabled)').all();
    if (days2.length >= ret.getDate()) await days2[ret.getDate() - 1].click();
    await page.waitForTimeout(1000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // === ADVANCED CONTROLS ===
    const advancedLink = await page.$('text=Show Advanced Controls');
    if (advancedLink) { await advancedLink.click(); await page.waitForTimeout(1500); }

    // === ROUTING: O:QR+ only (no X:DOH — DOH is origin, not a connection) ===
    const routingInputs = await page.locator('input[placeholder="Routing"]').all();
    if (routingInputs.length >= 2) {
      await routingInputs[0].fill('O:QR+');
      await routingInputs[1].fill('O:QR+');
    }
    log('Routing: O:QR+ (Qatar operated, non-stop from DOH)');

    // === CABIN: Business ===
    await page.click('text=Cabin');
    await page.waitForTimeout(500);
    const bizOption = await page.locator('mat-option').filter({ hasText: 'Business' }).first();
    await bizOption.click();
    await page.waitForTimeout(500);

    // === SUBMIT ===
    log('Searching...');
    await page.locator('button.search-button').click();
    await page.waitForTimeout(50000);

    const finalText = await page.evaluate(() => document.body.innerText);

    const priceMatch = finalText.match(/(SAR|BHD|AED|QAR|KWD|OMR|USD|EUR|GBP)\s?([\d,]+)/);
    if (!priceMatch) {
      log('No non-stop flights found from DOH');
      return { found: false, origin: 'DOH', destination, departDate, returnDate,
               cheapestLocal: null, cheapestUSD: null, cheapestQAR: null, flights: [], isDOHDirect: true };
    }

    const currency = priceMatch[1];
    const amount = parseFloat(priceMatch[2].replace(/,/g, ''));
    const usd = toUSD(amount, currency);
    const qar = toQAR(usd);

    log(`DOH non-stop cheapest: ${currency} ${amount.toLocaleString()} (~$${usd} USD / ~QAR ${qar})`);

    const flights = parseResultRows(finalText);

    return {
      found: true,
      origin: 'DOH',
      destination,
      departDate,
      returnDate,
      cheapestLocal: { currency, amount },
      cheapestUSD: usd,
      cheapestQAR: qar,
      flights,
      isDOHDirect: true,
      qrOnly: true
    };

  } catch (error) {
    log(`Error: ${error.message}`);
    return {
      found: false, origin: 'DOH', destination, departDate, returnDate,
      error: error.message, cheapestLocal: null, cheapestUSD: null, cheapestQAR: null,
      flights: [], isDOHDirect: true
    };
  } finally {
    await browser.close();
  }
}

module.exports = { searchFlight, searchDOHDirect, EXCHANGE_RATES, toUSD, toQAR };
