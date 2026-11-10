//! A broken component fails `cargo build` with Zubra's message, file and line included.

use std::fs;
use std::path::Path;
use std::process::Command;

fn build(name: &str, component: &str, usage: &str) -> (bool, String) {
    prepare(name, component, usage);
    cargo_build(name)
}

fn prepare(name: &str, component: &str, usage: &str) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let dir = root.join("target").join("macro-fixtures").join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src")).unwrap();
    fs::create_dir_all(dir.join("components")).unwrap();
    fs::write(
        dir.join("Cargo.toml"),
        format!(
            "[package]\nname = \"{name}\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\n[workspace]\n\n[dependencies]\nzubra = {{ path = {root:?} }}\nzubra-macros = {{ path = {macros:?} }}\n",
            root = root.to_string_lossy(),
            macros = root.join("macros").to_string_lossy(),
        ),
    )
    .unwrap();
    // The workspace's lockfile, so the fixture builds the dependency versions the project tests with.
    fs::copy(root.join("Cargo.lock"), dir.join("Cargo.lock")).unwrap();
    fs::write(dir.join("components/broken.zb"), component).unwrap();
    fs::write(dir.join("src/main.rs"), usage).unwrap();
}

fn cargo_build(name: &str) -> (bool, String) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let dir = root.join("target").join("macro-fixtures").join(name);
    let output = Command::new(env!("CARGO"))
        .args(["build", "--quiet", "--color", "never"])
        .current_dir(&dir)
        .env(
            "CARGO_TARGET_DIR",
            root.join("target").join("macro-fixtures-target"),
        )
        .output()
        .unwrap();
    (
        output.status.success(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

const MAIN: &str = "fn main() { let _ = zubra_macros::include_zb!(\"components/broken.zb\"); }\n";

#[test]
fn a_component_that_does_not_compile_fails_the_build_with_its_message() {
    let (ok, stderr) = build(
        "broken-component",
        "<x-broken>\n  <p>{missing}</p>\n</x-broken>\n",
        MAIN,
    );
    assert!(!ok, "the build should have failed");
    assert!(stderr.contains("components/broken.zb:2"), "{stderr}");
    assert!(stderr.contains("missing"), "{stderr}");
}

#[test]
fn a_good_component_builds() {
    let (ok, stderr) = build("good-component", "<x-broken><p>fine</p></x-broken>\n", MAIN);
    assert!(ok, "{stderr}");
}

#[test]
fn a_missing_file_fails_the_build_naming_it() {
    let (ok, stderr) = build(
        "missing-file",
        "<x-broken></x-broken>\n",
        "fn main() { let _ = zubra_macros::include_zb!(\"components/nope.zb\"); }\n",
    );
    assert!(!ok);
    assert!(stderr.contains("nope.zb"), "{stderr}");
}

#[test]
fn something_other_than_a_string_literal_is_refused() {
    let (ok, stderr) = build(
        "not-a-literal",
        "<x-broken></x-broken>\n",
        "fn main() { let _ = zubra_macros::include_zb!(42); }\n",
    );
    assert!(!ok);
    assert!(stderr.contains("string literal"), "{stderr}");
}

#[test]
fn editing_an_imported_component_rebuilds_and_rechecks_it() {
    let name = "edited-import";
    prepare(
        name,
        "<script>\n  import './part.zb'\n</script>\n<x-broken><x-part></x-part></x-broken>\n",
        MAIN,
    );
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let part = root
        .join("target/macro-fixtures")
        .join(name)
        .join("components/part.zb");
    fs::write(&part, "<x-part><p>fine</p></x-part>\n").unwrap();
    let (ok, stderr) = cargo_build(name);
    assert!(ok, "{stderr}");
    // Only the imported file changes; the build must notice.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    fs::write(&part, "<x-part><p>{nope}</p></x-part>\n").unwrap();
    let (ok, stderr) = cargo_build(name);
    assert!(!ok, "the edit to the import was not noticed");
    assert!(stderr.contains("nope"), "{stderr}");
}

#[test]
fn a_path_with_escapes_is_refused() {
    let (ok, stderr) = build(
        "escaped-path",
        "<x-broken></x-broken>\n",
        "fn main() { let _ = zubra_macros::include_zb!(\"components\\\\broken.zb\"); }\n",
    );
    assert!(!ok);
    assert!(stderr.contains("without escapes"), "{stderr}");
}

/// The compiler's own "error" lines (not cargo's "could not compile" summary).
fn errors(stderr: &str) -> Vec<&str> {
    stderr
        .lines()
        .filter(|line| line.starts_with("error") && !line.contains("could not compile"))
        .collect()
}

#[test]
fn a_failure_is_one_error_wherever_the_macro_is_used() {
    // As a `let`'s value, as a closure's body with a declared type, and as an argument: a bare
    // `compile_error!(…);` in these places added a second error about the `;` or the type.
    for (name, usage) in [
        ("one-error-let", "fn main() { let _ = zubra_macros::include_zb!(\"components/broken.zb\"); }\n"),
        ("one-error-static", "static CARD: std::sync::LazyLock<zubra::Component> = std::sync::LazyLock::new(|| zubra_macros::include_zb!(\"components/broken.zb\"));\nfn main() { let _ = CARD.path(); }\n"),
        ("one-error-argument", "fn show(card: zubra::Component) { let _ = card.path(); }\nfn main() { show(zubra_macros::include_zb!(\"components/broken.zb\")); }\n"),
    ] {
        let (ok, stderr) = build(name, "<x-broken>\n  <p>{missing}</p>\n</x-broken>\n", usage);
        assert!(!ok, "{name}: the build should have failed");
        let found = errors(&stderr);
        assert_eq!(found.len(), 1, "{name}: {stderr}");
        assert!(stderr.contains("components/broken.zb:2"), "{name}: {stderr}");
    }
}

#[test]
fn a_literal_passed_on_by_another_macro_is_taken() {
    let usage = "macro_rules! component { ($path:literal) => { zubra_macros::include_zb!($path) }; }\nfn main() { let card = component!(\"components/broken.zb\"); assert_eq!(card.tag().unwrap(), \"x-broken\"); }\n";
    let (ok, stderr) = build(
        "forwarded-literal",
        "<x-broken><p>fine</p></x-broken>\n",
        usage,
    );
    assert!(ok, "{stderr}");
    // Something that isn't a string is still refused when it comes through a macro.
    let usage = "macro_rules! component { ($path:literal) => { zubra_macros::include_zb!($path) }; }\nfn main() { let _ = component!(42); }\n";
    let (ok, stderr) = build("forwarded-number", "<x-broken></x-broken>\n", usage);
    assert!(!ok);
    assert!(stderr.contains("string literal"), "{stderr}");
}
