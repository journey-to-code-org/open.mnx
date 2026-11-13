//! An async `resource()` fetcher's reads after an `await`: the compiler routes them through the
//! run's `track()`, so they re-run the fetcher as reads before the `await` do (ECMAScript
//! roadmap E4).

use zubra::compile_js;

fn js(script: &str) -> String {
    let source = format!(
        "<script>\n  import {{ resource }} from '@zubra/runtime'\n  let page = 1\n{script}\n</script>\n<x-list org>\n  <p>{{rows.value}}</p>\n</x-list>"
    );
    compile_js(&source, "@zubra/runtime", "x.zb").unwrap()
}

#[test]
fn reads_after_the_first_await_are_tracked_and_reads_before_it_are_not() {
    let out = js(r#"  const rows = resource(async ({ signal }) => {
    const r = await fetch(`/api/${org}?page=${page}`, { signal })
    const data = await r.json()
    return { data, page, org }
  })"#);
    assert!(
        out.contains("const rows = resource($tracked(($run) => (async ({ signal }) => {"),
        "{out}"
    );
    // The operand of the first `await` runs before it waits: the effect tracks it.
    assert!(
        out.contains("await fetch(`/api/${$p.org}?page=${page.get()}`, { signal })"),
        "{out}"
    );
    // Shorthand properties keep their key.
    assert!(
        out.contains(
            "return { data, page: $run.track(() => page.get()), org: $run.track(() => $p.org) }"
        ),
        "{out}"
    );
    assert!(out.contains("})($run)))"), "{out}");
}

#[test]
fn a_read_in_a_loop_with_an_await_is_tracked_from_the_loop_on() {
    let out = js(r#"  const rows = resource(async () => {
    const first = page
    const out = []
    for (const n of [1, 2]) {
      out.push(org)
      await fetch(`/x/${n}`)
    }
    return [first, out]
  })"#);
    assert!(out.contains("const first = page.get()"), "{out}");
    // Its second time round runs after the first `await`.
    assert!(out.contains("out.push($run.track(() => $p.org))"), "{out}");
    let out = js(r#"  const rows = resource(async () => {
    const first = page
    for await (const chunk of stream(org)) {}
    return first
  })"#);
    assert!(out.contains("const first = page.get()"), "{out}");
    assert!(out.contains("stream($run.track(() => $p.org))"), "{out}");
}

#[test]
fn a_function_inside_the_fetcher_is_tracked_wherever_it_is() {
    let out = js(r#"  const rows = resource(async () => {
    const pick = (x) => x + page
    return [await load(), pick(1)]
  })"#);
    assert!(
        out.contains("const pick = (x) => x + $run.track(() => page.get())"),
        "{out}"
    );
    // An `await` in a nested function doesn't make the fetcher's own code after it later.
    let out = js(r#"  const rows = resource(async () => {
    const retry = async () => { await wait(10) }
    const first = page
    await load()
    return [first, retry]
  })"#);
    assert!(out.contains("const first = page.get()"), "{out}");
}

#[test]
fn writes_and_fetchers_that_are_not_async_are_left_as_they_were() {
    let out = js(r#"  const rows = resource(async () => {
    const r = await load()
    page = r.next
    return r
  })"#);
    assert!(out.contains("__zubraAssign(page, r.next)"), "{out}");
    assert!(!out.contains("$run.track(() => page.get())"), "{out}");
    let out = js("  const rows = resource(({ signal }) => fetch(`/y/${page}`, { signal }))");
    assert!(
        out.contains(
            "const rows = resource(({ signal }) => fetch(`/y/${page.get()}`, { signal }))"
        ),
        "{out}"
    );
    assert!(!out.contains("$run"), "{out}");
    assert!(!out.contains("runtime/track"), "{out}");
}

#[test]
fn a_resource_in_a_fetcher_has_its_own_run() {
    let out = js(r#"  const rows = resource(async () => {
    await load()
    const inner = resource(async () => { await load(); return page })
    return [inner, org]
  })"#);
    assert!(
        out.contains(
            "const inner = resource($tracked(($run) => (async () => { await load(); return $run.track(() => page.get()) })($run)))"
        ),
        "{out}"
    );
    assert!(
        out.contains("return [inner, $run.track(() => $p.org)]"),
        "{out}"
    );
}

#[test]
fn only_the_runtime_resource_is_rewritten() {
    let source = "<script>\n  import { resource } from './my-data.js'\n  let page = 1\n  const rows = resource(async () => { await load(); return page })\n</script>\n<x-list>\n  <p>{rows}</p>\n</x-list>";
    let out = compile_js(source, "@zubra/runtime", "x.zb").unwrap();
    assert!(!out.contains("$run"), "{out}");
    assert!(out.contains("return page.get()"), "{out}");
    // Renamed on import, it still is.
    let source = "<script>\n  import { resource as load } from '@zubra/runtime'\n  let page = 1\n  const rows = load(async () => { await next(); return page })\n</script>\n<x-list>\n  <p>{rows.value}</p>\n</x-list>";
    let out = compile_js(source, "@zubra/runtime", "x.zb").unwrap();
    assert!(
        out.contains("load($tracked(($run) => (async () => { await next(); return $run.track(() => page.get()) })($run)))"),
        "{out}"
    );
}

fn js_with(imports: &str, script: &str) -> String {
    let source = format!(
        "<script>\n  import {{ {imports} }} from '@zubra/runtime'\n  let page = 1\n{script}\n</script>\n<x-list org>\n  <p>{{rows.value}}</p>\n</x-list>"
    );
    compile_js(&source, "@zubra/runtime", "x.zb").unwrap()
}

#[test]
fn an_explicit_get_on_a_signal_after_the_first_await_is_tracked() {
    let out = js_with(
        "resource, state",
        r#"  const rate = state(2)
  const rows = resource(async () => {
    const before = rate.get()
    await load()
    return [before, rate.get(), rate?.get()]
  })"#,
    );
    assert!(out.contains("const before = rate.get()"), "{out}");
    assert!(
        out.contains(
            "return [before, $run.track(() => rate.get()), $run.track(() => rate?.get())]"
        ),
        "{out}"
    );
    // Writing one isn't a read.
    let out = js_with(
        "resource, state",
        r#"  const rate = state(2)
  const rows = resource(async () => {
    await load()
    rate.set(3)
  })"#,
    );
    assert!(!out.contains("$run"), "{out}");
}

#[test]
fn a_fetcher_that_is_not_async_is_tracked_in_its_callbacks() {
    let out =
        js("  const rows = resource(({ signal }) => load(signal).then((r) => r.slice(0, page)))");
    assert!(
        out.contains(
            "resource($tracked(($run) => (({ signal }) => load(signal).then((r) => r.slice(0, $run.track(() => page.get()))))($run)))"
        ),
        "{out}"
    );
    assert!(out.contains("@zubra/runtime/track"), "{out}");
    let out = js(r#"  const rows = resource(function ({ signal }) {
    return load(signal).then(function (r) { return [r, org] })
  })"#);
    assert!(
        out.contains("return [r, $run.track(() => $p.org)]"),
        "{out}"
    );
}

#[test]
fn a_fetcher_with_nothing_to_follow_later_is_left_as_written() {
    // Every read is before the first `await`: no `$tracked`, and the module isn't loaded.
    let out = js(r#"  const rows = resource(async ({ signal }) => {
    const r = await fetch(`/api/${org}?page=${page}`, { signal })
    return r.json()
  })"#);
    assert!(
        out.contains("const rows = resource(async ({ signal }) => {"),
        "{out}"
    );
    assert!(!out.contains("$run"), "{out}");
    assert!(!out.contains("runtime/track"), "{out}");
    // A nested resource that follows its own reads doesn't make the outer one tracked.
    let out = js(r#"  const rows = resource(async () => {
    const first = page
    await load()
    return resource(async () => { await load(); return org })
  })"#);
    assert!(out.contains("const rows = resource(async () => {"), "{out}");
    assert!(
        out.contains("return resource($tracked(($run) => (async () => { await load(); return $run.track(() => $p.org) })($run)))"),
        "{out}"
    );
}

#[test]
fn jsx_and_tsx_components_are_rewritten_too() {
    for (path, types) in [("x.zb.jsx", ""), ("x.zb.tsx", ": { org?: string }")] {
        let source = format!(
            "import {{ resource as load }} from '@zubra/runtime'\n\nexport default function XRows({{ org = 'a' }}{types}) {{\n  let page = 1\n  const rows = load(async () => {{\n    await next()\n    return [page, org]\n  }})\n  return <p onClick={{() => page++}}>{{rows.value}}</p>\n}}\n"
        );
        let out = compile_js(&source, "@zubra/runtime", path).unwrap();
        assert!(
            out.contains("const rows = load($tracked(($run) => (async () => {"),
            "{path}: {out}"
        );
        assert!(
            out.contains("return [$run.track(() => page.get()), $run.track(() => $p.org)]"),
            "{path}: {out}"
        );
        assert!(
            out.contains("import { tracked as $tracked } from \"@zubra/runtime/track\""),
            "{path}: {out}"
        );
    }
}
