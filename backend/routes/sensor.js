const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();
const pool = require("../model/db"); // ✅ PostgreSQL connection
const cron = require("node-cron");

const checkAndNotify = require('../utils/checkandNotify');
const router = express.Router();
router.use(express.json());
router.use(cors());

const BLYNK_API = `https://blr1.blynk.cloud/external/api/get?token=${process.env.BLYNK_TOKEN}&v2&v1`;

// 🔹 Function to Determine Condition
const determineCondition = (temperature, humidity) => {
    if ((temperature >= 10 && temperature <= 30 && humidity >= 30 && humidity <= 60) ||
    (temperature >= 15 && temperature <= 40 && humidity >= 60 && humidity <= 80)) {
  return "Ideal Cond.";
} else if ((temperature >= 5 && temperature <= 40 && humidity >= 20 && humidity <= 30) ||
           (temperature >= 25 && temperature <= 45 && humidity >= 30 && humidity <= 50) ||
           (temperature >= 30 && temperature <= 45 && humidity >= 50 && humidity <= 70)) {
  return "Marginal Cond.";
} else {
  return "Non-Ideal Cond.";
}
};

// 🔹 Fetch & Store Data Every Hour (PostgreSQL)
const fetchAndStoreSensorData = async () => {
    try {
      const response = await axios.get(BLYNK_API);
      const temperature = response.data.v2;
      const humidity = response.data.v1;
      const condition = determineCondition(temperature, humidity);
  
      const currentHour = new Date();
      currentHour.setMinutes(0, 0, 0);
  
      const checkQuery = `
        SELECT id FROM sensor_tables
        WHERE timestamp >= NOW() - INTERVAL '1 hour' 
        LIMIT 1;
      `;
      const { rows } = await pool.query(checkQuery);
  
      if (rows.length > 0) {
        console.log("⚠️ Data already exists for this hour. Skipping storage...");
        return;
      }
  
      // Save data
      const insertQuery = `
        INSERT INTO sensor_tables (temperature, humidity, condition, timestamp)
        VALUES ($1, $2, $3, NOW());
      `;
      await pool.query(insertQuery, [temperature, humidity, condition]);
  
      // ✅ Send alert if condition is non-ideal
      await checkAndNotify(temperature, humidity);
  
      console.log(`✅ Data stored in PostgreSQL at: ${currentHour}`);
    } catch (error) {
      console.error("❌ Error fetching or storing data:", error);
    }
  };
  
// 🔹 Cron Job: Runs Every Hour
cron.schedule("0 * * * *", async () => {
    console.log("⏳ Running scheduled sensor data fetch...");
    await fetchAndStoreSensorData();
});
router.get("/get-hourly-data", async (req, res) => {
  try {
    const { hour } = req.query; // ✅ Make sure this line exists

    const query = `
      SELECT * FROM sensor_tables 
      WHERE EXTRACT(HOUR FROM timestamp) = $1
      ORDER BY timestamp ASC;
    `;
    const { rows } = await pool.query(query, [hour]);
    
    res.json(rows);
  } catch (err) {
    console.error("❌ Error in /get-hourly-data route:", err.message);
    res.status(500).send("Server error");
  }
});

// 🔹 Route to Get Last 24 Hours of Data (One Entry Per Hour)
router.get("/get-24hr-data", async (req, res) => {
    try {
        const query = `
            SELECT * FROM sensor_tables 
            WHERE timestamp >= NOW() - INTERVAL '24 hours' 
            ORDER BY timestamp ASC;
        `;

        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (error) {
        console.error("❌ Error fetching data:", error);
        res.status(500).send("Server error");
    }
});
router.get("/predict-24hr-data", async (req, res) => {
    try {
        // ✅ Fetch last 24-hour data from PostgreSQL
        const { rows } = await pool.query(
            "SELECT temperature, humidity FROM sensor_tables ORDER BY timestamp DESC LIMIT 24"
        );

        if (rows.length < 24) return res.status(400).json({ error: "Not enough data" });

        const inputData = rows.map((row) => [row.temperature, row.humidity]);

        // ✅ Send Data to Flask API
        const response = await axios.post("http://localhost:5001/predict", {
            sensor_data: inputData
        });

        const predictions = response.data.predictions;

        // ✅ Store predictions in PostgreSQL
        for (let i = 0; i < predictions.length; i++) {
            const [temperature, humidity] = predictions[i];

            await pool.query(
                "INSERT INTO predicted_sensor_tables (temperature, humidity, timestamp) VALUES ($1, $2, NOW() + INTERVAL '1 hour' * $3)",
                [temperature, humidity, i + 1]
            );
        }

        res.json({ message: "Predictions stored successfully!", predictions });
    } catch (error) {
        console.error("❌ Prediction error:", error);
        res.status(500).json({ error: "Prediction failed" });
    }
});

// 🔹 One-call route: live Blynk fetch + ML prediction + spraying condition
router.get("/live-condition", async (req, res) => {
  try {
    let temperature;
    let humidity;
    let source = "blynk-live";

    try {
      const blynkResponse = await axios.get(BLYNK_API);
      temperature = parseFloat(blynkResponse.data.v2);
      humidity = parseFloat(blynkResponse.data.v1);
      if (Number.isNaN(temperature) || Number.isNaN(humidity)) {
        throw new Error("Blynk returned invalid numeric values");
      }
    } catch (blynkErr) {
      const latest = await pool.query(
        "SELECT temperature, humidity FROM sensor_tables ORDER BY timestamp DESC LIMIT 1"
      );
      if (!latest.rows.length) {
        return res.status(500).json({
          error: "No live sensor data available from Blynk and no fallback data in database",
        });
      }
      source = "database-fallback";
      temperature = parseFloat(latest.rows[0].temperature);
      humidity = parseFloat(latest.rows[0].humidity);
      console.error("⚠️ Blynk unavailable, using DB fallback:", blynkErr.message);
    }

    const condition = determineCondition(temperature, humidity);

    const hour = new Date().getHours();
    let predictedTemperature = null;

    try {
      const mlResponse = await axios.post("http://localhost:5001/predict", {
        sensor_data: [[temperature, humidity, hour]],
      });
      const prediction = mlResponse?.data?.predictions;
      if (Array.isArray(prediction) && prediction.length > 0) {
        predictedTemperature = prediction[0];
      }
    } catch (mlErr) {
      // Keep realtime condition available even if ML service is temporarily down.
      console.error("⚠️ ML prediction skipped:", mlErr.message);
    }

    res.json({
      source,
      timestamp: new Date().toISOString(),
      current: {
        temperature,
        humidity,
        condition,
      },
      prediction: {
        predictedTemperature,
      },
    });
  } catch (error) {
    console.error("❌ Error in /live-condition:", error.message);
    res.status(500).json({ error: "Live condition fetch failed" });
  }
});

module.exports = router;