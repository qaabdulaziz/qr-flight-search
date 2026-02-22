// Common city/destination to airport code mapping
// Used so users can type "London" instead of "LHR"
const CITY_TO_AIRPORT = {
  // Morocco
  'casablanca': 'CMN', 'marrakech': 'RAK', 'marrakesh': 'RAK', 'rabat': 'RBA',
  'fez': 'FEZ', 'fes': 'FEZ', 'tangier': 'TNG',

  // Europe
  'london': 'LHR', 'london heathrow': 'LHR', 'london gatwick': 'LGW',
  'paris': 'CDG', 'paris cdg': 'CDG', 'paris orly': 'ORY',
  'amsterdam': 'AMS', 'rome': 'FCO', 'milan': 'MXP', 'madrid': 'MAD',
  'barcelona': 'BCN', 'frankfurt': 'FRA', 'munich': 'MUC', 'berlin': 'BER',
  'vienna': 'VIE', 'zurich': 'ZRH', 'geneva': 'GVA', 'brussels': 'BRU',
  'dublin': 'DUB', 'lisbon': 'LIS', 'athens': 'ATH', 'istanbul': 'IST',
  'copenhagen': 'CPH', 'oslo': 'OSL', 'stockholm': 'ARN', 'helsinki': 'HEL',
  'warsaw': 'WAW', 'prague': 'PRG', 'budapest': 'BUD', 'bucharest': 'OTP',
  'edinburgh': 'EDI', 'manchester': 'MAN', 'birmingham': 'BHX',
  'nice': 'NCE', 'venice': 'VCE', 'florence': 'FLR',

  // Asia
  'tokyo': 'NRT', 'tokyo narita': 'NRT', 'tokyo haneda': 'HND',
  'osaka': 'KIX', 'singapore': 'SIN', 'hong kong': 'HKG', 'hongkong': 'HKG',
  'bangkok': 'BKK', 'kuala lumpur': 'KUL', 'kl': 'KUL',
  'seoul': 'ICN', 'taipei': 'TPE', 'manila': 'MNL', 'jakarta': 'CGK',
  'bali': 'DPS', 'denpasar': 'DPS', 'hanoi': 'HAN', 'ho chi minh': 'SGN',
  'beijing': 'PEK', 'shanghai': 'PVG', 'guangzhou': 'CAN',
  'delhi': 'DEL', 'new delhi': 'DEL', 'mumbai': 'BOM', 'bombay': 'BOM',
  'bangalore': 'BLR', 'bengaluru': 'BLR', 'chennai': 'MAA', 'hyderabad': 'HYD',
  'kolkata': 'CCU', 'kochi': 'COK', 'cochin': 'COK', 'ahmedabad': 'AMD',
  'colombo': 'CMB', 'kathmandu': 'KTM', 'dhaka': 'DAC',
  'karachi': 'KHI', 'lahore': 'LHE', 'islamabad': 'ISB',
  'maldives': 'MLE', 'male': 'MLE',

  // Middle East
  'doha': 'DOH', 'dubai': 'DXB', 'abu dhabi': 'AUH',
  'riyadh': 'RUH', 'jeddah': 'JED', 'dammam': 'DMM', 'bahrain': 'BAH',
  'muscat': 'MCT', 'kuwait': 'KWI', 'amman': 'AMM', 'beirut': 'BEY',
  'cairo': 'CAI', 'tehran': 'IKA', 'baghdad': 'BGW', 'erbil': 'EBL',

  // Africa
  'nairobi': 'NBO', 'addis ababa': 'ADD', 'cape town': 'CPT',
  'johannesburg': 'JNB', 'lagos': 'LOS', 'accra': 'ACC', 'dar es salaam': 'DAR',
  'tunis': 'TUN', 'algiers': 'ALG', 'zanzibar': 'ZNZ',
  'kilimanjaro': 'JRO', 'entebbe': 'EBB',

  // Americas
  'new york': 'JFK', 'nyc': 'JFK', 'new york jfk': 'JFK', 'newark': 'EWR',
  'los angeles': 'LAX', 'la': 'LAX', 'san francisco': 'SFO', 'sf': 'SFO',
  'chicago': 'ORD', 'miami': 'MIA', 'houston': 'IAH', 'dallas': 'DFW',
  'washington': 'IAD', 'washington dc': 'IAD', 'boston': 'BOS', 'seattle': 'SEA',
  'atlanta': 'ATL', 'philadelphia': 'PHL', 'denver': 'DEN',
  'toronto': 'YYZ', 'montreal': 'YUL', 'vancouver': 'YVR',
  'sao paulo': 'GRU', 'rio de janeiro': 'GIG', 'buenos aires': 'EZE',
  'mexico city': 'MEX', 'bogota': 'BOG', 'lima': 'LIM', 'santiago': 'SCL',

  // Oceania
  'sydney': 'SYD', 'melbourne': 'MEL', 'brisbane': 'BNE', 'perth': 'PER',
  'auckland': 'AKL',
};

// Reverse map: IATA code -> city name (for richer labels on direct code input)
const CODE_TO_CITY = Object.fromEntries(
  Object.entries(CITY_TO_AIRPORT).map(([city, code]) => [code, city])
);

/**
 * Resolve a user input to an airport code.
 * Accepts: airport code (CMN), city name (Casablanca), or city + airport (London Heathrow)
 * Returns: { code, label } or null
 */
function resolveAirport(input) {
  if (!input) return null;
  const cleaned = input.trim();
  const lower = cleaned.toLowerCase();

  // If it's already a 3-letter alpha airport code
  if (/^[A-Za-z]{3}$/.test(cleaned)) {
    const code = cleaned.toUpperCase();
    const cityName = CODE_TO_CITY[code];
    const label = cityName
      ? `${cityName.charAt(0).toUpperCase() + cityName.slice(1)} (${code})`
      : code;
    return { code, label };
  }

  // Exact city match
  if (CITY_TO_AIRPORT[lower]) {
    return { code: CITY_TO_AIRPORT[lower], label: `${cleaned} (${CITY_TO_AIRPORT[lower]})` };
  }

  // Partial match — only for inputs of 3+ chars, and only startsWith to avoid false matches
  // e.g. "lon" -> "london", but "la" won't accidentally match "kuala lumpur"
  if (lower.length >= 3) {
    for (const [city, code] of Object.entries(CITY_TO_AIRPORT)) {
      if (city.startsWith(lower)) {
        return { code, label: `${city.charAt(0).toUpperCase() + city.slice(1)} (${code})` };
      }
    }
    // Fallback: input starts with city name (e.g. "London Heathrow" -> "london")
    for (const [city, code] of Object.entries(CITY_TO_AIRPORT)) {
      if (lower.startsWith(city)) {
        return { code, label: `${city.charAt(0).toUpperCase() + city.slice(1)} (${code})` };
      }
    }
  }

  return null;
}

module.exports = { resolveAirport, CITY_TO_AIRPORT };
