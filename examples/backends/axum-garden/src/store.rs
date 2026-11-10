//! The garden's data, in memory (the Flask example keeps it in SQLite; the point here is the
//! components, not the database).

use serde_json::{json, Value};

pub const CROPS: [(&str, &str); 8] = [
    ("tomatoes", "Tomatoes"),
    ("beans", "Beans"),
    ("kale", "Kale"),
    ("squash", "Squash"),
    ("peppers", "Peppers"),
    ("herbs", "Herbs"),
    ("garlic", "Garlic"),
    ("flowers", "Flowers"),
];
pub const MAX_CROPS: usize = 3;

pub fn crop_name(value: &str) -> Option<&'static str> {
    CROPS
        .iter()
        .find(|(crop, _)| *crop == value)
        .map(|(_, label)| *label)
}

#[derive(Clone, Debug, Default)]
pub struct Signup {
    pub name: String,
    pub email: String,
    pub crops: Vec<String>,
    pub household: i64,
}

#[derive(Clone, Debug)]
struct Plot {
    id: String,
    size: &'static str,
    sun: &'static str,
    holder: Option<String>,
    waiting: usize,
}

#[derive(Debug)]
pub struct Store {
    plots: Vec<Plot>,
    harvests: Vec<(String, String, f64)>,
}

impl Default for Store {
    fn default() -> Self {
        let mut store = Store {
            plots: Vec::new(),
            harvests: Vec::new(),
        };
        store.reset();
        store
    }
}

impl Store {
    pub fn reset(&mut self) {
        self.plots.clear();
        for (row, sun) in "ABCD".chars().zip(["full", "full", "part", "shade"]) {
            for column in 1..=4 {
                self.plots.push(Plot {
                    id: format!("{row}{column}"),
                    size: if column < 4 { "4×8 ft" } else { "8×8 ft" },
                    sun,
                    holder: None,
                    waiting: 0,
                });
            }
        }
        for (plot, name) in [
            ("A1", "Rosa Diaz"),
            ("A4", "Sam Okafor"),
            ("B2", "Lee Park"),
            ("C3", "Ana Lima"),
        ] {
            self.plot_mut(plot).holder = Some(name.to_owned());
        }
        self.plot_mut("A1").waiting = 1;
        self.harvests = [
            ("A1", "tomatoes", 6.5),
            ("A1", "peppers", 2.0),
            ("B2", "kale", 3.5),
            ("B2", "garlic", 1.5),
            ("C3", "beans", 4.0),
            ("A4", "squash", 9.0),
        ]
        .into_iter()
        .map(|(plot, crop, kg)| (plot.to_owned(), crop.to_owned(), kg))
        .collect();
    }

    fn plot_mut(&mut self, id: &str) -> &mut Plot {
        self.plots
            .iter_mut()
            .find(|plot| plot.id == id)
            .expect("a known plot")
    }

    fn json(plot: &Plot) -> Value {
        json!({
            "id": plot.id, "size": plot.size, "sun": plot.sun,
            "holder": plot.holder, "waiting": plot.waiting,
            "status": if plot.holder.is_some() { "taken" } else { "open" },
        })
    }

    pub fn plots(&self) -> Vec<Value> {
        self.plots.iter().map(Self::json).collect()
    }

    pub fn plot(&self, id: &str) -> Option<Value> {
        self.plots.iter().find(|plot| plot.id == id).map(Self::json)
    }

    pub fn reserve(&mut self, id: &str, signup: &Signup) {
        self.plot_mut(id).holder = Some(signup.name.clone());
    }

    /// The signup's place on the waitlist, counting from 1.
    pub fn join_waitlist(&mut self, id: &str) -> usize {
        let plot = self.plot_mut(id);
        plot.waiting += 1;
        plot.waiting
    }

    pub fn log_harvest(&mut self, plot: &str, crop: &str, kg: f64) {
        self.harvests.push((plot.to_owned(), crop.to_owned(), kg));
    }

    /// Kilograms per crop, most first, then by crop name.
    pub fn harvest_by_crop(&self) -> Vec<(String, f64)> {
        let mut totals: Vec<(String, f64)> = Vec::new();
        for (_, crop, kg) in &self.harvests {
            match totals.iter_mut().find(|(name, _)| name == crop) {
                Some((_, total)) => *total += kg,
                None => totals.push((crop.clone(), *kg)),
            }
        }
        totals.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap().then_with(|| a.0.cmp(&b.0)));
        totals
            .into_iter()
            .map(|(crop, kg)| (crop, (kg * 10.0).round() / 10.0))
            .collect()
    }
}
