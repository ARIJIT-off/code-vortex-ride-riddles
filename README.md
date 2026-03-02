# Ride Riddles

## 📖 Project Description
Ride Riddles is an intelligent, full-stack navigation web application designed specifically for Kolkata (New Town, Salt Lake, and Central). It calculates the optimal route between landmarks using live OpenStreetMap data and a custom **Bidirectional A\*** routing engine. 

What makes it unique is its **Mode & Preference Awareness**. Whether you're driving a car, riding a bike, or walking, the app snaps to accessible roads and filters paths based on your preference for a **Smooth Road**, **Shaded Road**, or the **Fastest Time**. It enriches these routes with a curated dataset of real-world Kolkata traffic levels and road conditions.

## 💻 Tech Stack
* **Frontend:** HTML5, CSS3, Vanilla JavaScript, Leaflet.js (Map Rendering)
* **Backend:** Node.js, Express.js
* **Routing Algorithm:** Custom Bidirectional A* Search
* **Data Sources:** OpenStreetMap (OSM) via Overpass API, Static JSON Curated Dataset

> **Note:** The backend server and the frontend application are completely integrated into this single project folder. You only need to run one command to start everything!

## 🚀 Quick Start Guide

### Prerequisites
Make sure you have [Node.js](https://nodejs.org/) installed on your system.

### Step 1: Download the App
1. Clone or download this repository to your local machine.
2. Extract the folder if it's in a `.zip` file.
3. Open a terminal or command prompt inside the extracted project folder (e.g., `ride riddles`).

### Step 2: Install Dependencies
In your terminal, run the following command to install the required Node.js packages (`express` and `cors`):
```bash
npm install
```

### Step 3: Run the Server
Start the application by running:
```bash
node server.js
```
*Wait a few seconds while the server fetches the latest live road data from OpenStreetMap and geocodes the landmarks. You will see a message when it's ready.*
```text
🚀 RIDE_RIDDLES ready → http://localhost:3000
```

### Step 4: Open the App
Once the server is running, open your favorite web browser and navigate to:
**[http://localhost:3000](http://localhost:3000)**

That's it! The frontend UI is served directly by the local Node.js server. 

---

## ⚙️ Features
* **Real OSM Data:** Fetches up-to-date road networks directly from the Overpass API.
* **Smart Routing Engine:** Uses an advanced bidirectional A* search with custom edge-cost penalties.
* **Mode-Aware Snapping:** Understands if you are walking, driving a car, or riding a bike, and snaps to the correct accessible road types (e.g., preventing cars from routing on pedestrian-only paths).
* **Curated Dataset Integration:** Leverages a `routeData.json` curated dataset to overlay highly accurate travel times, distances, traffic levels (Low/Medium/High), and road conditions (potholes/shade).
* **Dynamic UI:** Features an interactive Leaflet map, alternative routes, expanding summary panels, and detailed road quality breakdowns.

## 🛠️ Project Structure
* `server.js` - Primary Express server that serves the frontend and the `/api/path` routes.
* `amcrRouter.js` - The custom Bidirectional A* routing algorithm and cost logic.
* `osmGraph.js` - Handles fetching, parsing, and caching the OpenStreetMap graph network.
* `routeLookup.js` - Enriches calculated routes with curated real-world traffic and distance data from `routeData.json`.
* `public/` - The frontend application:
  * `index.html` - The UI structure.
  * `style.css` - Custom clean and modern styling.
  * `app.js` - Handles user interaction and API calls to the local server.
  * `mapRenderer.js` - Handles drawing the paths and animated map emojis using Leaflet.js.
