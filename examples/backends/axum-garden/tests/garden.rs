//! The garden over HTTP: its pages, its forms, and (with `FLASK_GARDEN_URL`) the same HTML as the
//! Flask example's.

use std::net::SocketAddr;

async fn serve() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, axum_garden::app()).await.unwrap() });
    format!("http://{address}")
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into()
}

fn get(url: &str) -> (u16, String) {
    let mut response = agent().get(url).call().unwrap();
    (
        response.status().as_u16(),
        response.body_mut().read_to_string().unwrap(),
    )
}

fn post(url: &str, form: &[(&str, &str)]) -> (u16, String, Option<String>) {
    let mut response = agent().post(url).send_form(form.iter().copied()).unwrap();
    let location = response
        .headers()
        .get("location")
        .map(|value| value.to_str().unwrap().to_owned());
    (
        response.status().as_u16(),
        response.body_mut().read_to_string().unwrap(),
        location,
    )
}

/// Whitespace between tags and inside runs is layout, not content.
fn normalized(html: &str) -> String {
    let mut collapsed = String::new();
    let mut space = false;
    for character in html.chars() {
        if character.is_whitespace() {
            space = true;
        } else {
            if space && !collapsed.is_empty() {
                collapsed.push(' ');
            }
            space = false;
            collapsed.push(character);
        }
    }
    collapsed.replace("> <", "><")
}

#[tokio::test(flavor = "multi_thread")]
async fn pages_are_server_rendered_html() {
    let base = serve().await;
    let (status, home) = tokio::task::spawn_blocking(move || get(&format!("{base}/")))
        .await
        .unwrap();
    assert_eq!(status, 200);
    assert!(
        home.contains("12 of 16 plots are open this season"),
        "{home}"
    );
    // The plot map arrived as markup, not as an empty element.
    assert!(home.contains("<plot-map") && home.contains("A1"), "{home}");
    assert!(home.contains("import '/components/plot-map.js'"), "{home}");
    assert!(home.contains("<style data-zb-components>"), "{home}");
}

#[tokio::test(flavor = "multi_thread")]
async fn signing_up_works_as_a_plain_form_post() {
    let base = serve().await;
    tokio::task::spawn_blocking(move || {
        // Errors come back with what was typed.
        let (status, body, _) = post(
            &format!("{base}/plots/B1"),
            &[
                ("email", "mo@example.org"),
                ("crops", "kale"),
                ("crops", "beans"),
                ("crops", "herbs"),
                ("crops", "garlic"),
                ("household", "2"),
            ],
        );
        assert_eq!(status, 422);
        assert!(body.contains("Your name, please."), "{body}");
        assert!(body.contains("Pick between 1 and 3 crops."), "{body}");
        assert!(body.contains("value=\"mo@example.org\""), "{body}");
        // A good one reserves the plot and redirects.
        let (status, _, location) = post(
            &format!("{base}/plots/B1"),
            &[
                ("name", "Mo Ali"),
                ("email", "mo@example.org"),
                ("crops", "kale"),
                ("household", "2"),
            ],
        );
        assert_eq!(status, 303);
        assert_eq!(location.as_deref(), Some("/plots/B1?done=reserved"));
        let (_, page) = get(&format!("{base}/plots/B1?done=reserved"));
        assert!(page.contains("It's yours!"), "{page}");
        let (_, taken) = get(&format!("{base}/plots/B1"));
        assert!(taken.contains("Gardened by Mo Ali."), "{taken}");
        // A taken plot takes a waitlist place.
        let (_, _, location) = post(
            &format!("{base}/plots/A4"),
            &[
                ("name", "Jo"),
                ("email", "jo@example.org"),
                ("crops", "kale"),
                ("household", "1"),
            ],
        );
        assert_eq!(location.as_deref(), Some("/plots/A4?done=waitlist-1"));
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn email_addresses_need_a_name_a_domain_and_a_dot_inside_it() {
    let base = serve().await;
    tokio::task::spawn_blocking(move || {
        for (email, ok) in [
            ("a@b.c", true),
            ("a@.com", false),
            ("a@b.", false),
            ("a@b", false),
            ("@b.c", false),
            ("a b@c.d", false),
            ("a@b@c.d", false),
        ] {
            let (status, _, _) = post(
                &format!("{base}/plots/B1"),
                &[
                    ("name", "Mo"),
                    ("email", email),
                    ("crops", "kale"),
                    ("household", "1"),
                ],
            );
            assert_eq!(status == 303, ok, "{email}");
            agent().post(&format!("{base}/reset")).send_empty().unwrap();
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn logging_a_harvest_updates_the_chart() {
    let base = serve().await;
    tokio::task::spawn_blocking(move || {
        let (_, before) = get(&format!("{base}/harvest"));
        let (status, _, location) = post(
            &format!("{base}/harvest"),
            &[("plot", "A1"), ("crop", "kale"), ("kg", "40")],
        );
        assert_eq!(
            (status, location.as_deref()),
            (303, Some("/harvest?plot=A1&logged=kale"))
        );
        let (_, after) = get(&format!("{base}/harvest"));
        assert_ne!(before, after);
        let (status, _, _) = post(
            &format!("{base}/harvest"),
            &[("plot", "A1"), ("crop", "kale"), ("kg", "0")],
        );
        assert_eq!(status, 422);
        // 100 kg is the most one entry can be.
        for (kg, expected) in [
            ("100", 303),
            ("100.5", 422),
            ("0.5", 303),
            ("-1", 422),
            ("lots", 422),
        ] {
            let (status, _, _) = post(
                &format!("{base}/harvest"),
                &[("plot", "A1"), ("crop", "kale"), ("kg", kg)],
            );
            assert_eq!(status, expected, "{kg} kg");
        }
        let (status, _) = get(&format!("{base}/plots/Z9"));
        assert_eq!(status, 404);
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn components_are_served_as_modules() {
    let base = serve().await;
    tokio::task::spawn_blocking(move || {
        let (status, module) = get(&format!("{base}/components/crop-picker.js"));
        assert_eq!(status, 200);
        assert!(module.contains("@zubra/runtime"), "{module}");
        assert_eq!(get(&format!("{base}/components/nope.js")).0, 404);
        assert_eq!(get(&format!("{base}/vendor/zubra/index.js")).0, 200);
        // Every entry the import map names is served: a component that spreads or animates
        // imports its own entry of the runtime.
        let (_, page) = get(&format!("{base}/"));
        let map = page
            .split("<script type=\"importmap\">")
            .nth(1)
            .and_then(|rest| rest.split("</script>").next())
            .expect("the layout has an import map");
        let map: serde_json::Value = serde_json::from_str(map).unwrap();
        let imports = map["imports"].as_object().unwrap();
        for entry in ["", "/spread", "/primitives", "/motion"] {
            let url = imports[&format!("@zubra/runtime{entry}")]
                .as_str()
                .unwrap_or_else(|| panic!("@zubra/runtime{entry} is not in the import map"));
            assert_eq!(get(&format!("{base}{url}")).0, 200, "{url}");
        }
        assert_eq!(
            get(&format!("{base}/vendor/zubra/..%2Fpackage.json")).0,
            404
        );
    })
    .await
    .unwrap();
}

/// What a visitor typed is stored and then written into pages other visitors see. It must come
/// back as text. (This runs without the Flask example: the comparison below only shows the two
/// agree, which they would if neither escaped.)
#[tokio::test(flavor = "multi_thread")]
async fn stored_names_are_escaped_wherever_they_are_shown() {
    let base = serve().await;
    tokio::task::spawn_blocking(move || {
        let name = "<img src=x onerror=alert(1)> \"Q\" & 'R' </script><script>alert(2)</script>";
        let (status, _, location) = post(
            &format!("{base}/plots/B1"),
            &[
                ("name", name),
                ("email", "mo@example.org"),
                ("crops", "kale"),
                ("household", "2"),
            ],
        );
        assert_eq!(status, 303);
        assert_eq!(location.as_deref(), Some("/plots/B1?done=reserved"));
        let escaped = "&lt;img src=x onerror=alert(1)&gt; &#34;Q&#34; &amp; &#39;R&#39; &lt;/script&gt;&lt;script&gt;alert(2)&lt;/script&gt;";
        let (_, plot) = get(&format!("{base}/plots/B1"));
        assert!(plot.contains(&format!("Gardened by {escaped}.")), "{plot}");
        for path in ["/", "/plots/B1", "/plots/B1?done=reserved", "/harvest", "/harvest?plot=B1"] {
            let (_, page) = get(&format!("{base}{path}"));
            assert!(!page.contains("<img src=x"), "{path}: {page}");
            assert!(!page.contains("alert(2)</script>"), "{path}: {page}");
            assert!(!page.contains("onerror=alert(1)>"), "{path}: {page}");
        }
    })
    .await
    .unwrap();
}

/// With the Flask example running (`FLASK_GARDEN_URL=http://127.0.0.1:5000`), every page is the
/// same HTML: the components and the layout agree, and so do the forms' error pages.
#[tokio::test(flavor = "multi_thread")]
async fn the_pages_match_the_flask_examples() {
    let Ok(flask) = std::env::var("FLASK_GARDEN_URL") else {
        eprintln!("FLASK_GARDEN_URL is not set: skipping the comparison with the Flask example");
        return;
    };
    let axum = serve().await;
    tokio::task::spawn_blocking(move || {
        for site in [&flask, &axum] {
            agent().post(&format!("{site}/reset")).send_empty().unwrap();
        }
        let pages = [
            "/",
            "/plots/A1",
            "/plots/B1",
            "/plots/A1?done=waitlist-2",
            "/plots/B1?done=reserved",
            "/harvest",
            "/harvest?plot=B2&logged=kale",
        ];
        for path in pages {
            let (a, b) = (
                get(&format!("{flask}{path}")),
                get(&format!("{axum}{path}")),
            );
            assert_eq!(a.0, b.0, "{path}: status");
            assert_eq!(normalized(&b.1), normalized(&a.1), "{path}");
        }
        // An invalid signup: the same errors page, with what was typed.
        let form = [
            ("name", ""),
            ("email", "nope"),
            ("crops", "kale"),
            ("crops", "beans"),
            ("crops", "herbs"),
            ("crops", "garlic"),
            ("household", "9"),
        ];
        let (a, b) = (
            post(&format!("{flask}/plots/B1"), &form),
            post(&format!("{axum}/plots/B1"), &form),
        );
        assert_eq!((a.0, b.0), (422, 422));
        assert_eq!(normalized(&b.1), normalized(&a.1), "the invalid signup");
        // What was typed is escaped the same way.
        let quoted = [
            ("name", "Mo \"M\" O'Neil <b>&"),
            ("email", ""),
            ("crops", "kale"),
            ("household", "2"),
        ];
        let (a, b) = (
            post(&format!("{flask}/plots/B1"), &quoted),
            post(&format!("{axum}/plots/B1"), &quoted),
        );
        assert_eq!(normalized(&b.1), normalized(&a.1), "escaping");
        // And a good one lands in the same place. Its name is stored, then written into other
        // pages: markup in it has to come back escaped, the same way on both.
        let good = [
            ("name", "Mo <b>\"M\"</b> & O'Neil"),
            ("email", "mo@example.org"),
            ("crops", "kale"),
            ("household", "2"),
        ];
        let (a, b) = (
            post(&format!("{flask}/plots/B1"), &good),
            post(&format!("{axum}/plots/B1"), &good),
        );
        assert_eq!((a.0, a.2.as_deref()), (b.0, b.2.as_deref()));
        let (a, b) = (
            get(&format!("{flask}/plots/B1")),
            get(&format!("{axum}/plots/B1")),
        );
        assert_eq!(normalized(&b.1), normalized(&a.1), "a reserved plot");
        assert!(
            b.1.contains("Gardened by Mo &lt;b&gt;&#34;M&#34;&lt;/b&gt; &amp; O&#39;Neil."),
            "{}",
            b.1
        );
        let (a, b) = (get(&format!("{flask}/")), get(&format!("{axum}/")));
        assert_eq!(normalized(&b.1), normalized(&a.1), "the map after a signup");
        // Each module is what the Flask example's compiler process writes.
        for name in [
            "crop-picker",
            "harvest-chart",
            "number-field",
            "plot-map",
            "status-pill",
        ] {
            let (a, b) = (
                get(&format!("{flask}/components/{name}.js")),
                get(&format!("{axum}/components/{name}.js")),
            );
            assert_eq!(b.1, a.1, "{name}.js");
        }
    })
    .await
    .unwrap();
}
