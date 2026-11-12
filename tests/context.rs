//! Context on the server: `provide()` in a component reaches `inject()` in the components it
//! renders, in the server's HTML; with no provider, the context's default.

use zubra::compile_html_with;

const THEME: &str = "import { createContext } from '@zubra/runtime';\nexport const theme = createContext('light');\n";
const THEMED: &str = "<script>\n  import { inject } from '@zubra/runtime'\n  import { theme } from './theme.js'\n  const mode = inject(theme)\n</script>\n<zb-themed>\n  <p class={mode}>{mode}</p>\n</zb-themed>";
const SHELL: &str = "<script>\n  import { provide } from '@zubra/runtime'\n  import { theme } from './theme.js'\n  import './themed.zb'\n  provide(theme, tone)\n</script>\n<zb-shell tone=\"dark\">\n  <zb-themed></zb-themed><zb-slot></zb-slot>\n</zb-shell>";

fn render(source: &str, with_module: bool) -> String {
    let loader = move |specifier: &str, _from: &str| match specifier {
        "./themed.zb" => Ok(("/app/themed.zb".to_owned(), THEMED.to_owned())),
        "./shell.zb" => Ok(("/app/shell.zb".to_owned(), SHELL.to_owned())),
        "./theme.js" if with_module => Ok(("/app/theme.js".to_owned(), THEME.to_owned())),
        _ => Err("not found".to_owned()),
    };
    compile_html_with(source, "/app/page.zb", "{}", "{}", &loader).unwrap()
}

#[test]
fn a_provided_value_reaches_what_the_provider_renders_and_no_further() {
    let page = "<script>\n  import './shell.zb'\n  import './themed.zb'\n</script>\n<zb-page>\n  <zb-shell tone=\"night\"></zb-shell><zb-themed></zb-themed>\n</zb-page>";
    let html = render(page, true);
    assert!(
        html.contains("<p class=\"night\">night</p>"),
        "inside the shell: {html}"
    );
    assert!(
        html.contains("data-zb-inject=\"{&quot;1&quot;:&quot;night&quot;}\""),
        "the element starts from it: {html}"
    );
    assert!(
        html.contains("<p class=\"light\">light</p>"),
        "after the shell: the default: {html}"
    );
    assert_eq!(
        html.matches("data-zb-inject").count(),
        1,
        "a default isn't written: {html}"
    );
}

#[test]
fn the_nearest_provider_wins_and_its_own_inject_sees_the_one_above() {
    let inner = "<script>\n  import { provide, inject } from '@zubra/runtime'\n  import { theme } from './theme.js'\n  import './themed.zb'\n  const outer = inject(theme)\n  provide(theme, outer + '-inner')\n</script>\n<zb-inner>\n  <i>{outer}</i><zb-themed></zb-themed>\n</zb-inner>";
    let page = "<script>\n  import { provide } from '@zubra/runtime'\n  import { theme } from './theme.js'\n  import './inner.zb'\n  provide(theme, 'outer')\n</script>\n<zb-page>\n  <zb-inner></zb-inner>\n</zb-page>";
    let loader = |specifier: &str, _from: &str| match specifier {
        "./themed.zb" => Ok(("/app/themed.zb".to_owned(), THEMED.to_owned())),
        "./inner.zb" => Ok(("/app/inner.zb".to_owned(), inner.to_owned())),
        "./theme.js" => Ok(("/app/theme.js".to_owned(), THEME.to_owned())),
        _ => Err("not found".to_owned()),
    };
    let html = compile_html_with(page, "/app/page.zb", "{}", "{}", &loader).unwrap();
    assert!(html.contains("<i>outer</i>"), "{html}");
    assert!(
        html.contains("<p class=\"outer-inner\">outer-inner</p>"),
        "{html}"
    );
}

#[test]
fn without_the_module_a_provided_value_still_renders_but_a_default_is_the_browsers() {
    let page = "<script>\n  import './shell.zb'\n</script>\n<zb-page>\n  <zb-shell></zb-shell>\n</zb-page>";
    let html = render(page, false);
    assert!(html.contains("<p class=\"dark\">dark</p>"), "{html}");
    // The lone one has no value on the server: it's left for the element.
    let error =
        zubra::compile_html_with(THEMED, "/app/themed.zb", "{}", "{}", &|_: &str, _: &str| {
            Err("no".to_owned())
        });
    assert!(error.is_err(), "{error:?}");
}
