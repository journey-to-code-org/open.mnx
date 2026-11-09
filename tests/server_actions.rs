//! `export async function save(formData) { 'use server'; … }`: server functions. The browser
//! module and the server HTML see only the endpoint's URL; `--emit server` carries the function.

use zubra::{compile, compile_js, compile_server};

const LOGIN: &str = r#"<script>
  import { db } from './db.js';
  import { shared } from './shared.js';
  let note = shared();
  export async function login(formData) {
    'use server';
    const user = await db.verify(formData.get('email'), shared());
    if (!user) return { error: "Invalid login" };
    return { ok: true };
  }
</script>
<login-form>
  <form action={login}>
    <input name="email" type="email" />
    <button formaction={login}>Log in</button>
  </form>
</login-form>"#;

#[test]
fn a_form_posts_to_the_function_with_or_without_javascript() {
    let html = compile(LOGIN, "{}").unwrap();
    assert!(
        html.contains(r#"<form action="/_zb/action/login-form/login" method="post">"#),
        "{html}"
    );
    assert!(
        html.contains(r#"<button formaction="/_zb/action/login-form/login" formmethod="post">"#),
        "{html}"
    );
    let js = compile_js(LOGIN, "@zubra/runtime", "login-form.zb").unwrap();
    assert!(
        js.contains(r#"action=\"/_zb/action/login-form/login\" method=\"post\""#),
        "{js}"
    );
}

#[test]
fn the_function_and_its_server_only_imports_never_reach_the_browser() {
    let js = compile_js(LOGIN, "@zubra/runtime", "login-form.zb").unwrap();
    assert!(!js.contains("db.js"), "{js}");
    assert!(!js.contains("db.verify"), "{js}");
    assert!(!js.contains("use server"), "{js}");
    assert!(!js.contains("Invalid login"), "{js}");
    // An import the rest of the script uses too stays.
    assert!(js.contains("./shared.js"), "{js}");
    // The script can still use the name: it's the URL.
    assert!(
        js.contains(r#"const login = "/_zb/action/login-form/login";"#),
        "{js}"
    );
}

#[test]
fn the_server_module_carries_the_function_and_the_imports_it_needs() {
    let server = compile_server(LOGIN).unwrap();
    assert!(server.contains("import { db } from './db.js';"), "{server}");
    assert!(
        server.contains("import { shared } from './shared.js';"),
        "{server}"
    );
    assert!(
        server.contains("export async function login(formData)"),
        "{server}"
    );
    assert!(
        server.contains(r#"export const tag = "login-form";"#),
        "{server}"
    );
    assert!(
        server.contains(r#""/_zb/action/login-form/login": login"#),
        "{server}"
    );
}

#[test]
fn an_authored_method_is_kept() {
    let source = "<script>export function save(data) { 'use server'; return 1 }</script>\n<zb-x><form action={save} method=\"dialog\"></form></zb-x>";
    let html = compile(source, "{}").unwrap();
    assert!(html.contains(r#"method="dialog""#), "{html}");
    assert!(!html.contains(r#"method="post""#), "{html}");
}

#[test]
fn a_component_without_server_functions_has_an_empty_server_module() {
    let server = compile_server("<zb-x><p>hi</p></zb-x>").unwrap();
    assert!(server.contains("export const actions = {};"), "{server}");
}

#[test]
fn only_use_server_functions_can_be_exported() {
    let error = compile(
        "<script>export function save() { return 1 }</script>\n<zb-x></zb-x>",
        "{}",
    )
    .unwrap_err();
    assert!(error.message.contains("can't export"), "{}", error.message);
    let error = compile(
        "<script>export function a() { 'use server' }\nexport function a2() {}</script>\n<zb-x></zb-x>",
        "{}",
    )
    .unwrap_err();
    assert!(error.message.contains("can't export"), "{}", error.message);
}
