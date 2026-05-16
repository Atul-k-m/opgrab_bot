# 🚀 OpportunityIQ

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node.js](https://img.shields.io/badge/Node.js-v18+-green.svg)](https://nodejs.org/)
[![Supabase](https://img.shields.io/badge/Supabase-Database-green.svg)](https://supabase.com/)

**OpportunityIQ** is an AI-powered Opportunity Intelligence Platform designed for students and developers. It aggregates, deduplicates, ranks, and delivers high-signal opportunities (internships, hackathons, placements, and hiring signals) directly to users via a Telegram bot and a modern web dashboard.

---

## ✨ Features

- 🤖 **Interactive Telegram Bot**: Frictionless onboarding and profile setup.
- 🔍 **Smart Scrapers**: Idempotent scrapers for platforms like Devfolio and Unstop with content hashing.
- 🧠 **AI-Powered (Coming Soon)**: Deduplication using `pgvector` and relevance ranking via Gemini 1.5 Flash.
- 📊 **Database Sync**: Real-time synchronization with Supabase Postgres.

---

## 🛠️ Tech Stack

- **Backend**: Node.js (ES Modules)
- **Database**: Supabase (PostgreSQL + `pgvector`)
- **Bot Framework**: Telegraf (Telegram Bot API)
- **Scraping**: Mocked for MVP (Extendable with Playwright/Axios)

---

## 🚀 Getting Started

### Prerequisites

- Node.js (v18 or higher)
- A Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- A Supabase Project

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd iqBot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up environment variables:
   ```bash
   cp .env.example .env
   ```
   Open `.env` and fill in your `TELEGRAM_BOT_TOKEN`, `SUPABASE_URL`, and `SUPABASE_KEY`.

### Database Setup

1. Go to your Supabase Dashboard.
2. Open the **SQL Editor**.
3. Copy the contents of `schema.sql` and run it to create the necessary tables and indexes.

---

## 📖 Usage

### Running the Telegram Bot

To start the bot in polling mode:
```bash
npm start
```

### Running the Scrapers

To run the mock scraper and see the idempotency check in action:
```bash
node src/scraper.js
```

---

## 🗺️ Roadmap

- [x] **Phase 1**: Telegram Bot MVP & Supabase Schema Integration.
- [ ] **Phase 2**: Real scrapers (Devfolio, Unstop) & AI Deduplication.
- [ ] **Phase 3**: Web Dashboard (Next.js) & Gmail OAuth Integration.
- [ ] **Phase 4**: Advanced Relevance Ranking & Pro Tier Monetization.

---

## 📄 License

This project is licensed under the ISC License.
