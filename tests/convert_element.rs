//! `zubra convert my-element.js`: a custom element class back to a `.zb` component.
//!
//! The proof is a fixed point: every component `--emit element` accepts, compiled, converted
//! back and compiled again, gives the same element. So the `.zb` it writes means what the
//! element does, and an element edited in that shape comes back as the `.zb` to keep.
use std::{fs, path::Path, process::Command};

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "zubra-convert-element-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// The element without its first line (which names the source file), with runs of spaces as
/// one: TypeScript's types are blanked to spaces in the element, and a converted file has none.
fn comparable(module: &str) -> String {
    module
        .lines()
        .skip(1)
        .map(|line| {
            line.split(' ')
                .filter(|word| !word.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn every_element_converts_back_to_a_zb_file_that_compiles_to_it() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let dir = temp_dir("round-trip");
    copy_dir(&root.join("registry/components"), &dir.join("registry"));
    copy_dir(
        &root.join("runtime/test/browser/fixtures"),
        &dir.join("fixtures"),
    );
    let mut files = Vec::new();
    for folder in ["registry", "fixtures", "fixtures/jsx"] {
        for entry in fs::read_dir(dir.join(folder)).unwrap() {
            let path = entry.unwrap().path();
            let name = path.to_string_lossy().into_owned();
            if name.ends_with(".zb") || name.ends_with(".zb.jsx") || name.ends_with(".zb.tsx") {
                files.push(path);
            }
        }
    }
    files.sort();
    let (mut same, mut refused) = (0, 0);
    let mut failures = Vec::new();
    for path in &files {
        let name = path.to_string_lossy().into_owned();
        let Ok(element) = zubra::compile_element_file(&name) else {
            refused += 1; // shadow DOM, zb-await…: there's no element to convert
            continue;
        };
        let stem = name.split(".zb").next().unwrap();
        let element_path = format!("{stem}.element.js");
        fs::write(&element_path, &element).unwrap();
        let conversion = match zubra::convert_element(&element, &element_path) {
            Ok(conversion) => conversion,
            Err(error) => {
                failures.push(format!("{name}: {}", error.message));
                continue;
            }
        };
        if !conversion.unsupported.is_empty() {
            failures.push(format!("{name}: {}", conversion.unsupported[0].message));
            continue;
        }
        let back = format!("{stem}.back.zb");
        fs::write(&back, &conversion.output).unwrap();
        match zubra::compile_element_file(&back) {
            Ok(again) if comparable(&again) == comparable(&element) => same += 1,
            Ok(_) => failures.push(format!(
                "{name}: the converted file compiles to a different element:\n{}",
                conversion.output
            )),
            Err(error) => failures.push(format!(
                "{name}: the converted file doesn't compile: {}\n{}",
                error.message, conversion.output
            )),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
    assert!(
        same >= 60,
        "{same} round-tripped ({refused} refused by --emit element)"
    );
}

/// An element written by hand in that shape: no `static zubra`, plain DOM calls, a listener with
/// the emitter's modifier checks.
#[test]
fn a_hand_written_element_converts() {
    let dir = temp_dir("hand");
    let path = dir.join("like-button.js");
    let source = r#"export class LikeButton extends HTMLElement {
  static observedAttributes = ["label", "count"];
  #props = { label: "Like", count: 0 };
  #updates = [];
  get label() { return this.#props.label; }
  set label(value) { this.#props.label = value; }
  get count() { return this.#props.count; }
  set count(value) { this.#props.count = value; }
  connectedCallback() { this.replaceChildren(this.#setup()); }
  #setup() {
    const element = this;
    const emit = (name, detail) => this.#fire(name, detail);
    function like() {
      element.count++;
      emit("like", element.count);
    }
    const content = clone(`<button type="button" class="like"></button> <span class="total"></span>`);
    const button = content.children[0];
    button.addEventListener("click", like);
    button.addEventListener("keydown", (event) => {
      if (!(event.key === "Enter")) return;
      if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      like(event);
    });
    const total = content.children[1];
    this.#updates = [
      bind(() => element.label, (value) => (button.textContent = value)),
      bind(() => `${element.count ?? ""} likes`, (value) => (total.textContent = value)),
      bind(() => element.count > 9, (value) => total.classList.toggle("many", Boolean(value))),
    ];
    return content;
  }
  #fire(name, detail) { return this.dispatchEvent(new CustomEvent(name, { detail })); }
}
customElements.define("like-button", LikeButton);
"#;
    fs::write(&path, source).unwrap();
    let conversion = zubra::convert_element(source, path.to_str().unwrap()).unwrap();
    for expected in [
        "import { emit } from '@zubra/runtime'",
        "count++;",
        "emit(\"like\", count);",
        "<like-button label=\"Like\" count={0}>",
        "onclick={like}",
        "onkeydown.enter.prevent={like}",
        ">{label}</button>",
        "class:many={count > 9}",
        ">{count} likes</span>",
    ] {
        assert!(
            conversion.output.contains(expected),
            "`{expected}` in:\n{}",
            conversion.output
        );
    }
    assert!(
        conversion.unsupported.is_empty(),
        "{:?}",
        conversion.unsupported
    );
    assert!(
        conversion.compile_error.is_none(),
        "{:?}",
        conversion.compile_error
    );
}

/// What it can't place is reported at its line, not guessed.
#[test]
fn what_it_cant_place_is_reported() {
    let source = r#"export class XA extends HTMLElement {
  static observedAttributes = [];
  #setup() {
    const element = this;
    const content = clone(`<p></p>`);
    const p = content.children[0];
    p.animate([{ opacity: 0 }, { opacity: 1 }], 200);
    this.#updates = [];
    return content;
  }
}
customElements.define("x-a", XA);
"#;
    let conversion = zubra::convert_element(source, "/tmp/x-a.js").unwrap();
    assert_eq!(
        conversion.unsupported.len(),
        1,
        "{:?}",
        conversion.unsupported
    );
    assert!(conversion.unsupported[0]
        .message
        .starts_with("not converted:"));
    assert_eq!(conversion.unsupported[0].span.line, 7);

    let error = zubra::convert_element(
        "export class XA extends HTMLElement {}\ncustomElements.define(\"x-a\", XA);",
        "/tmp/x-a.js",
    )
    .unwrap_err();
    assert!(error.message.contains("#setup()"), "{}", error.message);
}

#[test]
fn the_command_line_converts_an_element() {
    let dir = temp_dir("cli");
    let component = dir.join("x-greeting.zb");
    fs::write(
        &component,
        "<x-greeting name=\"you\"><p>Hello, {name}!</p></x-greeting>\n",
    )
    .unwrap();
    let element = zubra::compile_element_file(component.to_str().unwrap()).unwrap();
    let element_path = dir.join("x-greeting.js");
    fs::write(&element_path, element).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_zubra"))
        .args(["convert", element_path.to_str().unwrap(), "--stdout"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "<x-greeting name=\"you\"><p>Hello, {name}!</p></x-greeting>\n"
    );
}

/// Through the request API (what `npx zubra convert` and the WebAssembly build use): the files
/// come with the request, and the child component is found among them.
#[test]
fn the_request_api_converts_an_element_with_its_children() {
    let badge = "<x-badge count={0}><b>{count}</b></x-badge>\n";
    let card = "<script>\n  import './x-badge.zb'\n</script>\n<x-card total={3}><x-badge count={total}></x-badge></x-card>\n";
    let dir = temp_dir("request");
    fs::write(dir.join("x-badge.zb"), badge).unwrap();
    fs::write(dir.join("x-card.zb"), card).unwrap();
    let element = zubra::compile_element_file(dir.join("x-card.zb").to_str().unwrap()).unwrap();
    let request = serde_json::json!({
        "command": "convert",
        "path": "/app/x-card.js",
        "files": { "/app/x-card.js": element, "/app/x-badge.zb": badge },
    });
    let response: serde_json::Value =
        serde_json::from_str(&zubra::handle_request(&request.to_string())).unwrap();
    assert_eq!(response["ok"], true, "{response}");
    let output = response["output"].as_str().unwrap();
    assert!(output.contains("import \"./x-badge.zb\""), "{output}");
    assert!(
        output.contains("<x-badge count={total}></x-badge>"),
        "{output}"
    );
    assert_eq!(response["complete"], true, "{response}");
}
