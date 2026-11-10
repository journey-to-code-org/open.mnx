//! Markup nests at most `MAX_DEPTH` elements deep: past that is an error, not a stack overflow
//! (natively a crash; in WebAssembly a trap that left the compiler unusable for every request
//! after it). Slot content matters most: it's the page's HTML, not the author's.
use zubra::{compile_html_with_options, compile_js, HtmlOptions, SlotSource};

fn nested(depth: usize) -> String {
    format!("{}x{}", "<div>".repeat(depth), "</div>".repeat(depth))
}

/// The compiler recurses once per level, and a debug build's frames are large: give the test the
/// room a release build has on a main thread, so it measures the limit and not the test thread.
fn with_room<T: Send + 'static>(run: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(run)
        .unwrap()
        .join()
        .unwrap()
}

fn slot(depth: usize, source: SlotSource) -> Result<String, zubra::Diagnostic> {
    compile_html_with_options(
        "<x-a><zb-slot></zb-slot></x-a>",
        "a.zb",
        "{}",
        &serde_json::json!({ "default": nested(depth) }).to_string(),
        HtmlOptions {
            slot_source: source,
            partial: true,
            pending: Vec::new(),
        },
        &zubra::filesystem,
    )
}

#[test]
fn markup_up_to_the_limit_compiles() {
    with_room(|| {
        // The host is one level; its content may go 255 more.
        let source = format!("<x-a>{}</x-a>", nested(255));
        assert!(compile_js(&source, "@zubra/runtime", "a.zb").is_ok());
        assert!(slot(256, SlotSource::Html).unwrap().contains("x</div>"));
    });
}

#[test]
fn deeper_markup_is_an_error_that_says_what_to_do() {
    with_room(|| {
        for depth in [256, 300, 5_000, 200_000] {
            let source = format!("<x-a>{}</x-a>", nested(depth));
            let error = compile_js(&source, "@zubra/runtime", "a.zb").unwrap_err();
            assert_eq!(
                error.message, "markup is nested more than 256 elements deep",
                "{depth}"
            );
            assert!(error.help.unwrap().contains("split the template"));
        }
    });
}

#[test]
fn deeper_slot_content_is_an_error_too() {
    with_room(|| {
        for source in [SlotSource::Html, SlotSource::Template] {
            for depth in [257, 800, 200_000] {
                let error = slot(depth, source).unwrap_err();
                assert_eq!(
                    error.message, "markup is nested more than 256 elements deep",
                    "{depth}"
                );
            }
        }
        let error = slot(800, SlotSource::Html).unwrap_err();
        assert!(error.help.unwrap().contains("slot content this deep"));
    });
}

#[test]
fn markup_in_braces_counts_toward_the_same_limit() {
    with_room(|| {
        let depth = 300;
        let source = format!(
            "<x-a n={{1}}>{}x{}</x-a>",
            "{n > 0 && <div>".repeat(depth),
            "</div>}".repeat(depth)
        );
        let error = compile_js(&source, "@zubra/runtime", "a.zb").unwrap_err();
        assert_eq!(
            error.message,
            "markup is nested more than 256 elements deep"
        );
    });
}
