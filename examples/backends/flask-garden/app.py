"""Run the garden: `python app.py` (http://localhost:5000)."""
import os

from garden import create_app

app = create_app(cache=os.environ.get("FLASK_DEBUG") != "1")

if __name__ == "__main__":
    app.run(port=int(os.environ.get("PORT", 5000)), debug=os.environ.get("FLASK_DEBUG") == "1")
