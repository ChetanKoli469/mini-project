from flask import Flask, request, jsonify
import joblib
import numpy as np
import pandas as pd
import psycopg2
from datetime import datetime, timedelta
from flask_cors import CORS
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "http://localhost:5173"}})


DB_CONFIG = {
    "host": "localhost",
    "database": "sensordata",
    "user": "postgres",
    "password": "14112005",
    "port": 5432,
}


def build_feature_row(sensor_data):
    values = np.array(sensor_data, dtype=float)

    if values.ndim == 1:
        flattened = values.reshape(-1)
        if flattened.size >= 3:
            return flattened[:3].reshape(1, -1)
        padded = np.pad(flattened, (0, 3 - flattened.size), mode="edge")
        return padded[:3].reshape(1, -1)

    if values.shape[1] >= 3:
        return values[-1, :3].reshape(1, -1)

    latest = values[-1]
    summary = float(np.mean(values))
    return np.array([[latest[0], latest[1], summary]], dtype=float)


def get_db_connection():
    return psycopg2.connect(**DB_CONFIG)

# ✅ Load Model
try:
    model = joblib.load("model.pkl")
    print("✅ Model loaded successfully!")
except Exception as e:
    print(f"❌ Error loading model: {e}")
    model = None

@app.route("/predict", methods=["POST"])
def predict():
    try:
        if model is None:
            return jsonify({"error": "Model not loaded!"}), 500

        data = request.json.get("sensor_data", [])
        
        if not data:
            return jsonify({"error": "No sensor data received"}), 400

        # ✅ Ensure Correct Input Shape
        data = build_feature_row(data)
        df = pd.DataFrame(data, columns=["temperature", "humidity", "feature_3"])
        print(f"Received data:\n{df}")  # Debugging step
        # ✅ Make Prediction
        prediction = model.predict(data)  # Predict next values
        prediction = prediction.tolist()  # Convert to list for JSON response

        return jsonify({"predictions": prediction})  

    except Exception as e:
        print(f"❌ Prediction failed: {str(e)}")
        return jsonify({"error": f"Prediction failed: {str(e)}"}), 500


@app.route("/predicted", methods=["GET"])
def get_predicted_data():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        cursor.execute("""
            SELECT temperature, humidity, timestamp
            FROM sensor_predicted_tables
            ORDER BY timestamp ASC
        """)
        rows = cursor.fetchall()

        formatted_data = []
        for row in rows:
            formatted_data.append({
                "timestamp": row[2].strftime("%Y-%m-%d %I:%M %p"),
                "temperature": f"{round(row[0], 2)}°C",
                "humidity": f"{round(row[1], 2)}%",
            })

        cursor.close()
        conn.close()

        return jsonify({"status": "success", "data": formatted_data})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/update_predict", methods=["POST"])
def update_predictions():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        cursor.execute("""
            SELECT temperature, humidity, timestamp
            FROM sensor_tables
            ORDER BY timestamp DESC
            LIMIT 24
        """)
        rows = cursor.fetchall()[::-1]

        if len(rows) < 24:
            return jsonify({"status": "error", "message": "Not enough data in the database for prediction!"}), 400

        feature_rows = np.array([
            [float(row[0]), float(row[1]), float(index)]
            for index, row in enumerate(rows)
        ], dtype=float)

        predicted_temperatures = model.predict(feature_rows)

        cursor.execute("DELETE FROM sensor_predicted_tables")

        now = datetime.now().replace(minute=0, second=0, microsecond=0)
        for index, row in enumerate(rows):
            temperature = float(predicted_temperatures[index])
            humidity = float(row[1])
            timestamp = now + timedelta(hours=index + 1)

            cursor.execute("""
                INSERT INTO sensor_predicted_tables (temperature, humidity, timestamp)
                VALUES (%s, %s, %s)
            """, (temperature, humidity, timestamp))

        conn.commit()
        cursor.close()
        conn.close()

        return jsonify({"status": "success", "message": "✅ Predictions updated successfully!"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

if __name__ == "__main__":
    app.run(port=5001, debug=True)

