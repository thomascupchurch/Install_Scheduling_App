# Install Scheduling App

This project is a scheduling application for managing installation appointments. It consists of a modern web frontend (React), a backend API (Node.js/Express), and a database (SQLite or PostgreSQL).

## Project Structure
- `frontend/` - React web application
- `backend/` - Node.js/Express API server

## Getting Started

### Prerequisites
- Node.js (v18+ recommended)
- npm or yarn

### Setup

#### Backend
1. Navigate to the `backend` folder:
   ```sh
   cd backend
   ```
2. Install dependencies:
   ```sh
   npm install
   ```
3. Configure environment variables (copy example and edit):
   ```sh
   copy .env.example .env  # Windows PowerShell: Copy-Item .env.example .env
   ```
   Edit `.env` and set at minimum:
   - `ORS_API_KEY` (OpenRouteService key for driving time / distance)
   - (Optional) `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` for calendar email exports.
4. Start the backend server:
   ```sh
   npm start
   ```
5. Verify health/config:
   ```sh
   curl http://localhost:3001/api/health
   ```
   Expected JSON: `{ ok: true, orsConfigured: true/false, time: "..." }`

#### Frontend
1. Navigate to the `frontend` folder:
   ```sh
   cd frontend
   ```
2. Install dependencies:
   ```sh
   npm install
   ```
3. Start the frontend app:
   ```sh
   npm start
   ```

## Features
- Create, view, and manage installation schedules
- Modern UI with React
- RESTful API with Express
- Persistent storage with SQLite or PostgreSQL
- Multi-day spillover with persisted schedule slices
- Driving time & distance caching via OpenRouteService (requires `ORS_API_KEY`)
- ICS calendar export with per-installer UID/sequence and optional SMTP email send

## License
MIT
