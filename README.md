# QR Flight Search

Qatar Airways Business Class flight search tool that compares prices from multiple origin airports via ITA Matrix.

## Features

- Search Qatar Airways Business Class flights from multiple origins
- Compare prices in USD, QAR, and local currency
- DOH (Doha) direct flight benchmark comparison
- Side-by-side price comparison showing savings
- Automatic retry for failed searches
- Parallel search with configurable concurrency

## Quick Start (Fresh Ubuntu)

```bash
# Clone the repository
git clone https://github.com/qaabdulaziz/qr-flight-search.git
cd qr-flight-search

# Run the setup script (installs Node.js, dependencies, Chromium)
chmod +x install.sh
./install.sh

# Start the server
npm start
```

The app will be available at `http://localhost:3000`

## Requirements

The `install.sh` script handles everything on a fresh Ubuntu server:
- Node.js v20
- npm dependencies
- Playwright/Chromium with system libraries
- Swap file (if RAM < 1GB)

### Manual Installation

If you prefer to install manually:

```bash
# Install Node.js v20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

# Install dependencies
npm install

# Install Playwright with Chromium
npx playwright install-deps chromium
npx playwright install chromium

# Start the server
npm start
```

## Environment Variables

Copy `.env.example` to `.env` and customize:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `MAX_PARALLEL` | 0 (unlimited) | Max concurrent searches. Use `2` for low-RAM servers |

## Production Usage

For servers with limited RAM (512MB - 1GB):

```bash
npm run start:prod
```

This sets `MAX_PARALLEL=2` to limit concurrent browser instances.

## Default Origin Airports

- DMM (Dammam)
- BAH (Bahrain)
- RUH (Riyadh)
- DXB (Dubai)
- AUH (Abu Dhabi)
- KWI (Kuwait)
- MCT (Muscat)

Plus DOH (Doha) as a direct flight benchmark.

## How It Works

1. Uses Playwright to automate ITA Matrix searches
2. Searches Qatar Airways Business Class flights routing via Doha (DOH)
3. Parses results and converts prices to USD/QAR
4. Displays cheapest options with flight details
5. Compares winner against DOH direct flights

## Tech Stack

- Node.js + Express
- Playwright (Chromium)
- ITA Matrix (flight search engine)

## License

MIT

## Author

[qaabdulaziz](https://github.com/qaabdulaziz)
