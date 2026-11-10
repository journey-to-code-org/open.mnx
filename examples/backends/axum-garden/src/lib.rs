//! Community garden plots: Axum, with the zubra components compiled into the binary.
//!
//! The same pages as `../flask-garden`, and the same `.zb` files, with no Node.js and no child
//! process: `include_zb!` checks each component at `cargo build`, and `Component::render` writes
//! its HTML in this process.

mod store;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};

use axum::extract::{Form, Path, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use zubra::Component;
use zubra_macros::include_zb;

use store::{crop_name, CROPS, MAX_CROPS};
pub use store::{Signup, Store};

/// The five components, checked when this crate is built. They are the Flask example's files.
static COMPONENTS: LazyLock<Vec<(&'static str, Component)>> = LazyLock::new(|| {
    vec![
        (
            "crop-picker",
            include_zb!("../flask-garden/components/crop-picker.zb"),
        ),
        (
            "harvest-chart",
            include_zb!("../flask-garden/components/harvest-chart.zb"),
        ),
        (
            "number-field",
            include_zb!("../flask-garden/components/number-field.zb"),
        ),
        (
            "plot-map",
            include_zb!("../flask-garden/components/plot-map.zb"),
        ),
        (
            "status-pill",
            include_zb!("../flask-garden/components/status-pill.zb"),
        ),
    ]
});

fn component(name: &str) -> Option<&'static Component> {
    COMPONENTS
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, component)| component)
}

const APP_CSS: &str = include_str!("../../flask-garden/static/app.css");

#[derive(Clone)]
pub struct App {
    store: Arc<Mutex<Store>>,
    runtime: Arc<PathBuf>,
}

/// The app with a fresh in-memory store. `ZUBRA_RUNTIME` names a folder with `@zubra/runtime`'s
/// ES modules; by default this repository's `runtime/src`.
pub fn app() -> Router {
    let runtime = std::env::var_os("ZUBRA_RUNTIME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../runtime/src"))
        });
    let state = App {
        store: Arc::new(Mutex::new(Store::default())),
        runtime: Arc::new(runtime),
    };
    Router::new()
        .route("/", get(home))
        .route("/plots/{id}", get(plot_page).post(sign_up))
        .route("/harvest", get(harvest).post(log_harvest))
        .route("/reset", post(reset))
        .route(
            "/static/app.css",
            get(|| async { ([(header::CONTENT_TYPE, "text/css")], APP_CSS) }),
        )
        .route("/components/{file}", get(component_module))
        .route("/vendor/zubra/{*path}", get(runtime_module))
        .with_state(state)
}

// ---- rendering --------------------------------------------------------------------------------

/// What one page rendered, so the layout can add those components' CSS and modules.
#[derive(Default)]
struct Page {
    used: Vec<&'static str>,
}

impl Page {
    fn render(&mut self, name: &'static str, props: Value) -> String {
        let (known, part) = COMPONENTS
            .iter()
            .find(|(known, _)| *known == name)
            .expect("a known component");
        if !self.used.contains(known) {
            self.used.push(known);
        }
        part.render(&props)
            .unwrap_or_else(|error| panic!("{name}: {error}"))
    }

    fn styles(&self) -> String {
        self.used
            .iter()
            .map(|name| component(name).unwrap().css().expect("css"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The whole page: the view first (so the layout knows what was used), then the layout.
    fn layout(&self, title: &str, body: &str) -> String {
        let modules: String = self
            .used
            .iter()
            .map(|name| format!("    import '/components/{name}.js';\n"))
            .collect();
        let scripts = if modules.is_empty() {
            String::new()
        } else {
            format!("  <script type=\"module\">\n{modules}  </script>\n")
        };
        format!(
            r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} · Garden plots</title>
  <link rel="stylesheet" href="/static/app.css">
  <style data-zb-components>{styles}</style>
  <script type="importmap">{{ "imports": {{ "@zubra/runtime": "/vendor/zubra/index.js", "@zubra/runtime/spread": "/vendor/zubra/spread.js", "@zubra/runtime/primitives": "/vendor/zubra/primitives.js" }} }}</script>
</head>
<body>
  <header class="top">
    <a class="brand" href="/">🌱 Garden plots</a>
    <nav aria-label="Main"><a href="/">Plots</a> <a href="/harvest">Harvest</a></nav>
  </header>
  <main>
{body}
  </main>
{scripts}</body>
</html>
"#,
            title = escape(title),
            styles = self.styles(),
        )
    }
}

/// Jinja's autoescape, so the output matches the Flask example's.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\'' => out.push_str("&#39;"),
            '"' => out.push_str("&#34;"),
            other => out.push(other),
        }
    }
    out
}

fn crop_options() -> Value {
    Value::Array(
        CROPS
            .iter()
            .map(|(value, label)| json!({ "value": value, "label": label }))
            .collect(),
    )
}

// ---- pages --------------------------------------------------------------------------------------

async fn home(State(app): State<App>) -> Html<String> {
    let plots = app.store.lock().unwrap().plots();
    let open = plots.iter().filter(|plot| plot["status"] == "open").count();
    let mut page = Page::default();
    let map = page.render("plot-map", json!({ "plots": plots, "columns": 4 }));
    let body = format!(
        "<h1>Plots</h1>\n<p class=\"lede\">{open} of {} plots are open this season. Pick one to sign up, or to join its waitlist.</p>\n{map}",
        plots.len()
    );
    Html(page.layout("Plots", &body))
}

#[derive(Default)]
struct Errors {
    name: Option<&'static str>,
    email: Option<&'static str>,
    crops: Option<String>,
    household: Option<&'static str>,
}

fn signup_form(
    app: &App,
    id: &str,
    signup: &Signup,
    errors: &Errors,
    done: Option<&str>,
    status: StatusCode,
) -> Response {
    let (plot, plots) = {
        let store = app.store.lock().unwrap();
        match store.plot(id) {
            Some(plot) => (plot, store.plots()),
            None => return StatusCode::NOT_FOUND.into_response(),
        }
    };
    let open = plot["status"] == "open";
    let mut page = Page::default();
    let pill = page.render(
        "status-pill",
        json!({ "status": plot["status"], "waiting": plot["waiting"] }),
    );
    let holder = plot["holder"]
        .as_str()
        .map(|holder| format!(" Gardened by {}.", escape(holder)))
        .unwrap_or_default();
    let main = if done == Some("reserved") {
        "      <p class=\"notice\" role=\"status\">It's yours! We'll email you the gate code.</p>\n"
            .to_owned()
    } else if let Some(place) = done.and_then(|done| done.strip_prefix("waitlist-")) {
        format!(
            "      <p class=\"notice\" role=\"status\">You're number {} on the waitlist.</p>\n",
            escape(place)
        )
    } else {
        let error = |message: Option<&str>| {
            message
                .map(|message| format!("        <p class=\"error\">{}</p>\n", escape(message)))
                .unwrap_or_default()
        };
        let picker = page.render(
            "crop-picker",
            json!({ "name": "crops", "options": crop_options(), "value": signup.crops, "max": MAX_CROPS, "legend": "Crops" }),
        );
        let household = page.render(
            "number-field",
            json!({ "name": "household", "value": signup.household, "min": 1, "max": 8, "step": 1, "label": "Household", "unit": "people" }),
        );
        format!(
            "      <h2>{heading}</h2>\n      <form method=\"post\" class=\"form\" novalidate>\n        <label>Name <input name=\"name\" value=\"{name}\" required autocomplete=\"name\"></label>\n{e_name}        <label>Email <input name=\"email\" type=\"email\" value=\"{email}\" required autocomplete=\"email\"></label>\n{e_email}        {picker}\n{e_crops}        {household}\n{e_household}        <button>{button}</button>\n      </form>\n",
            heading = if open { "Sign up" } else { "Join the waitlist" },
            name = escape(&signup.name),
            email = escape(&signup.email),
            e_name = error(errors.name),
            e_email = error(errors.email),
            e_crops = error(errors.crops.as_deref()),
            e_household = error(errors.household),
            button = if open { format!("Reserve plot {id}") } else { "Join waitlist".to_owned() },
        )
    };
    let map = page.render(
        "plot-map",
        json!({ "plots": plots, "selected": id, "columns": 4 }),
    );
    let body = format!(
        "<div class=\"split\">\n  <section>\n    <h1>Plot {id} {pill}</h1>\n    <p>{size}, {sun} sun.{holder}</p>\n{main}  </section>\n  <aside>\n    {map}\n  </aside>\n</div>",
        id = escape(id),
        size = escape(plot["size"].as_str().unwrap()),
        sun = escape(plot["sun"].as_str().unwrap()),
    );
    (status, Html(page.layout(&format!("Plot {id}"), &body))).into_response()
}

fn empty_signup() -> Signup {
    Signup {
        household: 1,
        ..Signup::default()
    }
}

async fn plot_page(
    State(app): State<App>,
    Path(id): Path<String>,
    query: axum::extract::Query<HashMap<String, String>>,
) -> Response {
    signup_form(
        &app,
        &id,
        &empty_signup(),
        &Errors::default(),
        query.get("done").map(String::as_str),
        StatusCode::OK,
    )
}

fn is_email(text: &str) -> bool {
    let Some((local, domain)) = text.split_once('@') else {
        return false;
    };
    let plain =
        |part: &str| !part.is_empty() && !part.contains('@') && !part.contains(char::is_whitespace);
    // `[^@\s]+\.[^@\s]+`: a dot with something before it and after it.
    plain(local)
        && plain(domain)
        && domain
            .char_indices()
            .any(|(at, c)| c == '.' && at > 0 && at + 1 < domain.len())
}

async fn sign_up(
    State(app): State<App>,
    Path(id): Path<String>,
    Form(form): Form<Vec<(String, String)>>,
) -> Response {
    if app.store.lock().unwrap().plot(&id).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let first = |key: &str| {
        form.iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.trim().to_owned())
            .unwrap_or_default()
    };
    let mut signup = Signup {
        name: first("name"),
        email: first("email"),
        crops: form
            .iter()
            .filter(|(name, value)| name == "crops" && crop_name(value).is_some())
            .map(|(_, value)| value.clone())
            .collect(),
        household: 0,
    };
    let mut errors = Errors::default();
    if signup.name.is_empty() {
        errors.name = Some("Your name, please.");
    }
    if !is_email(&signup.email) {
        errors.email = Some("An email address we can reach you at.");
    }
    if !(1..=MAX_CROPS).contains(&signup.crops.len()) {
        errors.crops = Some(format!("Pick between 1 and {MAX_CROPS} crops."));
    }
    match first("household").parse::<i64>() {
        Ok(household) if (1..=8).contains(&household) => signup.household = household,
        _ => {
            errors.household = Some("Between 1 and 8 people.");
            signup.household = 1;
        }
    }
    if errors.name.is_some()
        || errors.email.is_some()
        || errors.crops.is_some()
        || errors.household.is_some()
    {
        return signup_form(
            &app,
            &id,
            &signup,
            &errors,
            None,
            StatusCode::UNPROCESSABLE_ENTITY,
        );
    }
    let done = {
        let mut store = app.store.lock().unwrap();
        if store.plot(&id).is_some_and(|plot| plot["status"] == "open") {
            store.reserve(&id, &signup);
            "reserved".to_owned()
        } else {
            format!("waitlist-{}", store.join_waitlist(&id))
        }
    };
    Redirect::to(&format!("/plots/{id}?done={done}")).into_response()
}

async fn harvest(
    State(app): State<App>,
    query: axum::extract::Query<HashMap<String, String>>,
) -> Html<String> {
    let (bars, taken) = {
        let store = app.store.lock().unwrap();
        let bars: Vec<Value> = store
            .harvest_by_crop()
            .into_iter()
            .map(|(crop, kg)| json!({ "crop": crop, "kg": kg, "label": crop_name(&crop).unwrap_or("") }))
            .collect();
        let taken: Vec<String> = store
            .plots()
            .iter()
            .filter(|plot| plot["status"] == "taken")
            .map(|plot| plot["id"].as_str().unwrap().to_owned())
            .collect();
        (bars, taken)
    };
    let chosen = query
        .get("plot")
        .cloned()
        .unwrap_or_else(|| taken.first().cloned().unwrap_or_default());
    let mut page = Page::default();
    let chart = page.render(
        "harvest-chart",
        json!({ "rows": bars, "heading": "This season" }),
    );
    let field = page.render(
        "number-field",
        json!({ "name": "kg", "value": 1, "min": 0.5, "max": 100, "step": 0.5, "label": "Weight", "unit": "kg" }),
    );
    let plots: String = taken
        .iter()
        .map(|id| {
            format!(
                "<option {}>{}</option>",
                if *id == chosen { "selected" } else { "" },
                escape(id)
            )
        })
        .collect();
    let crops: String = CROPS
        .iter()
        .map(|(value, label)| format!("<option value=\"{value}\">{label}</option>"))
        .collect();
    let logged = if query.contains_key("logged") {
        "<p class=\"notice\" role=\"status\">Logged.</p>\n".to_owned()
    } else {
        String::new()
    };
    let body = format!(
        "<h1>Harvest</h1>\n{logged}<div class=\"split\">\n  <section>\n    {chart}\n  </section>\n  <section>\n    <h2>Log a harvest</h2>\n    <form method=\"post\" class=\"form\">\n      <label>Plot\n        <select name=\"plot\">\n          {plots}\n        </select>\n      </label>\n      <label>Crop\n        <select name=\"crop\">\n          {crops}\n        </select>\n      </label>\n      {field}\n      <button>Log harvest</button>\n    </form>\n  </section>\n</div>"
    );
    Html(page.layout("Harvest", &body))
}

async fn log_harvest(State(app): State<App>, Form(form): Form<Vec<(String, String)>>) -> Response {
    let field = |key: &str| {
        form.iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
            .unwrap_or_default()
    };
    let (plot, crop) = (field("plot"), field("crop"));
    let kg: f64 = field("kg").trim().parse().unwrap_or(0.0);
    let mut store = app.store.lock().unwrap();
    if store.plot(&plot).is_none() || crop_name(&crop).is_none() || !(kg > 0.0 && kg <= 100.0) {
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    store.log_harvest(&plot, &crop, kg);
    Redirect::to(&format!("/harvest?plot={plot}&logged={crop}")).into_response()
}

async fn reset(State(app): State<App>) -> StatusCode {
    app.store.lock().unwrap().reset();
    StatusCode::NO_CONTENT
}

// ---- assets -----------------------------------------------------------------------------------------

async fn component_module(Path(file): Path<String>) -> Response {
    let Some(name) = file.strip_suffix(".js") else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match component(name) {
        Some(part) => (
            [(header::CONTENT_TYPE, "text/javascript")],
            part.module().expect("module"),
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn runtime_module(State(app): State<App>, Path(path): Path<String>) -> Response {
    if path.split('/').any(|part| part == ".." || part.is_empty()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match tokio::fs::read(app.runtime.join(&path)).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, "text/javascript")], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}
