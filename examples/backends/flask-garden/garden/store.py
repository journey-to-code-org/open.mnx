"""The garden's data, in SQLite (the standard library's sqlite3)."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone

CROPS = [
    ("tomatoes", "Tomatoes"), ("beans", "Beans"), ("kale", "Kale"), ("squash", "Squash"),
    ("peppers", "Peppers"), ("herbs", "Herbs"), ("garlic", "Garlic"), ("flowers", "Flowers"),
]
CROP_NAMES = dict(CROPS)
MAX_CROPS = 3

SCHEMA = """
create table plots (id text primary key, size text not null, sun text not null);
create table reservations (plot text primary key references plots, name text, email text,
  crops text, household integer, at text);
create table waitlist (id integer primary key, plot text references plots, name text,
  email text, crops text, household integer, at text);
create table harvests (id integer primary key, plot text references plots, crop text,
  kg real, at text);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: str = ":memory:"):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        if not self.db.execute("select name from sqlite_master where name='plots'").fetchone():
            self.reset()

    def reset(self) -> None:
        with self.db:
            for table in ("harvests", "waitlist", "reservations", "plots"):
                self.db.execute(f"drop table if exists {table}")
            self.db.executescript(SCHEMA)
            for row, sun in zip("ABCD", ("full", "full", "part", "shade")):
                for column in range(1, 5):
                    size = "4×8 ft" if column < 4 else "8×8 ft"
                    self.db.execute("insert into plots values (?, ?, ?)", (f"{row}{column}", size, sun))
            for plot, name, crops in (
                ("A1", "Rosa Diaz", ["tomatoes", "peppers"]),
                ("A4", "Sam Okafor", ["squash"]),
                ("B2", "Lee Park", ["kale", "garlic", "herbs"]),
                ("C3", "Ana Lima", ["beans", "flowers"]),
            ):
                self.db.execute(
                    "insert into reservations values (?, ?, ?, ?, ?, ?)",
                    (plot, name, f"{name.split()[0].lower()}@example.org", json.dumps(crops), 2, _now()),
                )
            self.db.execute(
                "insert into waitlist (plot, name, email, crops, household, at) values (?, ?, ?, ?, ?, ?)",
                ("A1", "Jo Ruiz", "jo@example.org", json.dumps(["tomatoes"]), 1, _now()),
            )
            for plot, crop, kg in (
                ("A1", "tomatoes", 6.5), ("A1", "peppers", 2.0), ("B2", "kale", 3.5),
                ("B2", "garlic", 1.5), ("C3", "beans", 4.0), ("A4", "squash", 9.0),
            ):
                self.db.execute(
                    "insert into harvests (plot, crop, kg, at) values (?, ?, ?, ?)", (plot, crop, kg, _now())
                )

    def plots(self) -> list[dict]:
        rows = self.db.execute(
            """select p.*, r.name as holder, (select count(*) from waitlist w where w.plot = p.id) as waiting
               from plots p left join reservations r on r.plot = p.id order by p.id"""
        ).fetchall()
        return [dict(row, status="taken" if row["holder"] else "open") for row in rows]

    def plot(self, id: str) -> dict | None:
        return next((plot for plot in self.plots() if plot["id"] == id), None)

    def reserve(self, plot: str, signup: dict) -> None:
        with self.db:
            self.db.execute(
                "insert into reservations values (?, ?, ?, ?, ?, ?)",
                (plot, signup["name"], signup["email"], json.dumps(signup["crops"]), signup["household"], _now()),
            )

    def join_waitlist(self, plot: str, signup: dict) -> int:
        with self.db:
            self.db.execute(
                "insert into waitlist (plot, name, email, crops, household, at) values (?, ?, ?, ?, ?, ?)",
                (plot, signup["name"], signup["email"], json.dumps(signup["crops"]), signup["household"], _now()),
            )
        return self.db.execute("select count(*) from waitlist where plot = ?", (plot,)).fetchone()[0]

    def log_harvest(self, plot: str, crop: str, kg: float) -> None:
        with self.db:
            self.db.execute("insert into harvests (plot, crop, kg, at) values (?, ?, ?, ?)", (plot, crop, kg, _now()))

    def harvest_by_crop(self) -> list[dict]:
        rows = self.db.execute(
            "select crop, sum(kg) as kg from harvests group by crop order by kg desc, crop"
        ).fetchall()
        return [{"crop": row["crop"], "kg": round(row["kg"], 1)} for row in rows]
