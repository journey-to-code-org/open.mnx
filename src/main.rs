use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    process::ExitCode,
};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            if !message.is_empty() {
                eprintln!("{message}");
            }
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    let command = arguments.next();
    if command.as_deref() == Some("check") {
        return check(arguments.collect());
    }
    if command.as_deref() == Some("convert") {
        return convert(arguments.collect());
    }
    // `zubra request`: one JSON request on stdin, the JSON response on stdout (what the
    // WebAssembly build exposes, for anything embedding the native compiler instead).
    if command.as_deref() == Some("request") {
        if let Some(argument) = arguments.next() {
            return Err(format!("unexpected argument `{argument}`"));
        }
        let request = std::io::read_to_string(std::io::stdin())
            .map_err(|error| format!("unable to read standard input: {error}"))?;
        println!("{}", zubra::handle_request(&request));
        return Ok(());
    }
    // `zubra serve`: one JSON request (or batch) per line on stdin, one JSON response per line on
    // stdout, until stdin closes. For servers in other languages: one process, no start-up cost
    // per render.
    if command.as_deref() == Some("serve") {
        if let Some(argument) = arguments.next() {
            return Err(format!("unexpected argument `{argument}`"));
        }
        use std::io::{BufRead, Write};
        let stdout = std::io::stdout();
        for line in std::io::stdin().lock().lines() {
            let line = line.map_err(|error| format!("unable to read standard input: {error}"))?;
            if line.trim().is_empty() {
                continue;
            }
            let mut out = stdout.lock();
            writeln!(out, "{}", zubra::handle_request(&line))
                .and_then(|()| out.flush())
                .map_err(|error| format!("unable to write the response: {error}"))?;
        }
        return Ok(());
    }
    if command.as_deref() != Some("compile") {
        return Err(
            "usage: zubra check <component.zb>... [--format human|json]\n       zubra convert <Component.jsx> [--prefix <word>] [--component <Name>] [--as jsx|zubra] [--out <file> | --stdout]\n       zubra request < request.json\n       zubra serve   (JSON lines: a request per line in, a response per line out)\n       zubra compile <component.zb> [--emit html|js|css|dts|manifest|html-data|interface] [--props <props.json>] [--slots <slots.json> [--slots-html]] [--partial] [--runtime <module>] [--keep-imports] [--no-imports] [--css-import <specifier> --css-import-inline <specifier>] [--framework react|vue] [--module-path <path>] [--output <file>]".into(),
        );
    }
    let source_path = arguments
        .next()
        .ok_or_else(|| "missing component source path".to_owned())?;
    let mut props_path = None;
    let mut slots_path = None;
    let mut slots_html = false;
    let mut partial = false;
    let mut output_path = None;
    let mut emit = "html".to_owned();
    let mut runtime = "@zubra/runtime".to_owned();
    let mut module_path = None;
    let mut keep_imports = false;
    let mut no_imports = false;
    let mut css_import = None;
    let mut css_import_inline = None;
    let mut framework = zubra::Framework::None;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--emit" => emit = arguments.next().unwrap_or_default(),
            "--runtime" => runtime = arguments.next().unwrap_or_default(),
            "--module-path" => module_path = arguments.next(),
            // For bundler plugins: leave `./x.zb` imports for the bundler to resolve.
            "--keep-imports" => keep_imports = true,
            // For --emit css: this component's stylesheet only (a bundler loads the others).
            "--no-imports" => no_imports = true,
            // For bundler plugins: import the <style> through the bundler instead of inlining it.
            "--css-import" => css_import = arguments.next(),
            "--css-import-inline" => css_import_inline = arguments.next(),
            // For --emit dts: type the default export as that framework's wrapper.
            "--framework" => {
                framework = match arguments.next().as_deref() {
                    Some("react") => zubra::Framework::React,
                    Some("vue") => zubra::Framework::Vue,
                    Some("svelte") => zubra::Framework::Svelte,
                    Some("solid") => zubra::Framework::Solid,
                    Some("none") => zubra::Framework::None,
                    other => {
                        return Err(format!(
                            "unknown --framework `{}`; expected react, vue, svelte, solid or none",
                            other.unwrap_or_default()
                        ))
                    }
                }
            }
            "--props" => props_path = arguments.next(),
            "--slots" => slots_path = arguments.next(),
            // The --slots content is HTML a server already rendered, kept as written.
            "--slots-html" => slots_html = true,
            // Leave what only the browser can compute for the element, instead of an error.
            "--partial" => partial = true,
            "--output" => output_path = arguments.next(),
            _ => return Err(format!("unexpected argument `{argument}`")),
        }
    }
    let source = fs::read_to_string(&source_path)
        .map_err(|error| format!("{source_path}: unable to read source: {error}"))?;
    for warning in zubra::warnings(&source) {
        eprint!("{}", warning.render_warning(&source, &source_path));
    }
    if emit != "html" {
        if props_path.is_some() || slots_path.is_some() || slots_html || partial {
            return Err(format!(
                "--props, --slots, --slots-html and --partial apply to --emit html, not --emit {emit}"
            ));
        }
        let name = Path::new(&source_path)
            .file_name()
            .map_or(source_path.clone(), |name| {
                name.to_string_lossy().into_owned()
            });
        // The JavaScript module the manifest describes: header.zb → header.js by default.
        let module_path = module_path.unwrap_or_else(|| {
            let stem = zubra::component_extension(&name).map_or(name.as_str(), |extension| {
                &name[..name.len() - extension.len()]
            });
            format!("{stem}.js")
        });
        let output = match emit.as_str() {
            "js" if css_import.is_some() || css_import_inline.is_some() => {
                match (&css_import, &css_import_inline) {
                    (Some(stylesheet), Some(inline)) => zubra::compile_js_for_bundler(
                        &source,
                        &source_path,
                        &runtime,
                        zubra::StyleImports { stylesheet, inline },
                        &zubra::filesystem,
                    ),
                    _ => return Err("--css-import and --css-import-inline go together".into()),
                }
            }
            "css" if no_imports => zubra::compile_css(&source),
            "css" => zubra::compile_css_file(&source_path),
            "js" if keep_imports => zubra::compile_js_with(
                &source,
                &source_path,
                &runtime,
                None,
                &zubra::filesystem,
            ),
            "js" => zubra::compile_js_file(&source_path, &runtime),
            "dts" => zubra::compile_declarations_for(&source, &name, framework),
            "manifest" => zubra::compile_manifest(&source, &module_path),
            "html-data" => zubra::compile_html_data(&source),
            "interface" => zubra::compile_interface(&source),
            _ => {
                return Err(format!(
                    "unknown --emit `{emit}`; expected html, js, css, dts, manifest, html-data or interface"
                ))
            }
        }
        .map_err(|diagnostic| diagnostic.render_in(&source, &source_path))?;
        return match output_path {
            Some(output_path) => write_atomically(&output_path, output.as_bytes()),
            None => {
                print!("{output}");
                Ok(())
            }
        };
    }

    // Props are optional: defaults come from the component's <script> and host tag.
    let props = match &props_path {
        Some(props_path) => fs::read_to_string(props_path)
            .map_err(|error| format!("{props_path}: unable to read props: {error}"))?,
        None => "{}".to_owned(),
    };
    let slots = match &slots_path {
        Some(slots_path) => fs::read_to_string(slots_path)
            .map_err(|error| format!("{slots_path}: unable to read slots: {error}"))?,
        None => "{}".to_owned(),
    };
    let slot_source = if slots_html {
        zubra::SlotSource::Html
    } else {
        zubra::SlotSource::Template
    };
    let html = zubra::compile_html_with_options(
        &source,
        &source_path,
        &props,
        &slots,
        zubra::HtmlOptions {
            slot_source,
            partial,
            pending: Vec::new(),
        },
        &zubra::filesystem,
    )
    .map_err(|diagnostic| diagnostic.render_in(&source, &source_path))?;
    if let Some(output_path) = output_path {
        write_atomically(&output_path, html.as_bytes())?;
    } else {
        println!("{html}");
    }
    Ok(())
}

fn write_atomically(output_path: &str, contents: &[u8]) -> Result<(), String> {
    let path = Path::new(output_path);
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::create_dir_all(parent)
        .map_err(|error| format!("{output_path}: unable to create output directory: {error}"))?;
    let name = path
        .file_name()
        .ok_or_else(|| format!("{output_path}: output path must name a file"))?;
    let temporary = parent.join(format!(
        ".{}.zb-tmp-{}",
        name.to_string_lossy(),
        std::process::id()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| {
                format!(
                    "{}: unable to create temporary output: {error}",
                    temporary.display()
                )
            })?;
        file.write_all(contents).map_err(|error| {
            format!(
                "{}: unable to write temporary output: {error}",
                temporary.display()
            )
        })?;
        file.sync_all().map_err(|error| {
            format!(
                "{}: unable to flush temporary output: {error}",
                temporary.display()
            )
        })?;
        fs::rename(&temporary, path)
            .map_err(|error| format!("{output_path}: unable to promote generated output: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// `zubra check`: every error and warning, for CI and editors; exits non-zero on errors.
fn check(arguments: Vec<String>) -> Result<(), String> {
    let mut files = Vec::new();
    let mut json = false;
    let mut stdin = false;
    let mut server = false;
    let mut arguments = arguments.into_iter();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--format" => match arguments.next().as_deref() {
                Some("json") => json = true,
                Some("human") => json = false,
                other => {
                    return Err(format!(
                        "unknown --format `{}`; expected human or json",
                        other.unwrap_or_default()
                    ))
                }
            },
            // An editor's unsaved text, checked as if it were at the one path given.
            "--stdin" => stdin = true,
            // What a server without JavaScript leaves out (rendered with the defaults).
            "--server" => server = true,
            _ if argument.starts_with("--") => {
                return Err(format!("unexpected argument `{argument}`"))
            }
            _ => files.push(argument),
        }
    }
    if files.is_empty() || (stdin && files.len() != 1) {
        return Err("usage: zubra check <component.zb>... [--format human|json] [--server] [--stdin (one path; source from standard input)]".into());
    }
    let mut report = Vec::new();
    let mut errors = 0;
    let mut human = String::new();
    for path in &files {
        let source = if stdin {
            std::io::read_to_string(std::io::stdin())
                .map_err(|error| format!("unable to read standard input: {error}"))?
        } else {
            fs::read_to_string(path)
                .map_err(|error| format!("{path}: unable to read source: {error}"))?
        };
        for warning in zubra::warnings(&source) {
            human.push_str(&warning.render_warning(&source, path));
            report.push(entry(path, &source, &warning, "warning"));
        }
        // The JavaScript output runs every check that doesn't need prop values.
        if let Err(error) = zubra::compile_js_with(
            &source,
            path,
            "@zubra/runtime",
            Some(".js"),
            &zubra::filesystem,
        ) {
            errors += 1;
            human.push_str(&error.render_in(&source, path));
            report.push(entry(path, &source, &error, "error"));
        } else if server {
            match zubra::server_gaps(&source, path, &zubra::filesystem) {
                Ok(gaps) => {
                    for (gap, error) in gaps {
                        if error {
                            errors += 1;
                            human.push_str(&gap.render_in(&source, path));
                        } else {
                            human.push_str(&gap.render_warning(&source, path));
                        }
                        report.push(entry(
                            path,
                            &source,
                            &gap,
                            if error { "error" } else { "warning" },
                        ));
                    }
                }
                Err(error) => {
                    errors += 1;
                    human.push_str(&error.render_in(&source, path));
                    report.push(entry(path, &source, &error, "error"));
                }
            }
        }
    }
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).expect("JSON serializes")
        );
    } else {
        eprint!("{human}");
        if errors == 0 {
            eprintln!(
                "checked {} file{}: no errors",
                files.len(),
                if files.len() == 1 { "" } else { "s" }
            );
        }
    }
    if errors > 0 {
        return Err(if json {
            String::new()
        } else {
            format!(
                "{errors} file{} with errors",
                if errors == 1 { "" } else { "s" }
            )
        });
    }
    Ok(())
}

fn entry(
    path: &str,
    _source: &str,
    diagnostic: &zubra::Diagnostic,
    severity: &str,
) -> serde_json::Value {
    let file = diagnostic
        .file
        .as_ref()
        .map_or(path, |(file, _)| file.as_str());
    serde_json::json!({
        "file": file,
        "line": diagnostic.span.line,
        "column": diagnostic.span.column,
        "severity": severity,
        "message": diagnostic.message,
        "help": diagnostic.help,
    })
}

/// `zubra convert`: a React function component, written out as a zubra JSX component next to it
/// (`--out` elsewhere, `--stdout` to print it). What wasn't converted is reported, and the exit
/// status is 1 then, so a script can tell.
fn convert(arguments: Vec<String>) -> Result<(), String> {
    let usage = "usage: zubra convert <Component.jsx> [--prefix <word>] [--component <Name>] [--as jsx|zubra] [--out <file> | --stdout]";
    let mut path = None;
    let mut prefix = None;
    let mut out = None;
    let mut stdout = false;
    let mut as_zb = false;
    let mut component = None;
    let mut iterator = arguments.into_iter();
    while let Some(argument) = iterator.next() {
        match argument.as_str() {
            "--prefix" => prefix = Some(iterator.next().ok_or(usage)?),
            "--component" => component = Some(iterator.next().ok_or(usage)?),
            "--as" => match iterator.next().as_deref() {
                Some("zubra") => as_zb = true,
                Some("jsx") => as_zb = false,
                other => {
                    return Err(format!(
                        "unknown --as `{}`; expected jsx or zubra",
                        other.unwrap_or_default()
                    ))
                }
            },
            "--out" => out = Some(iterator.next().ok_or(usage)?),
            "--stdout" => stdout = true,
            other if other.starts_with("--") => {
                return Err(format!("unexpected argument `{other}`"))
            }
            _ if path.is_some() => return Err(usage.into()),
            _ => path = Some(argument),
        }
    }
    let path = path.ok_or(usage)?;
    let source = fs::read_to_string(&path)
        .map_err(|error| format!("{path}: unable to read source: {error}"))?;
    let mut conversion =
        zubra::convert_component(&source, &path, prefix.as_deref(), component.as_deref())
            .map_err(|diagnostic| diagnostic.render_in(&source, &path))?;
    let mut lowering_error = None;
    if as_zb {
        if conversion.unsupported.is_empty() && conversion.compile_error.is_none() {
            lowering_error = zubra::convert_as_zb(&mut conversion);
        } else {
            conversion.changes.push("left as JSX: `--as zubra` writes the .zb file once nothing is left to finish by hand".to_owned());
        }
    }
    let target = out.unwrap_or_else(|| {
        std::path::Path::new(&path)
            .with_file_name(&conversion.file_name)
            .to_string_lossy()
            .into_owned()
    });
    // Written elsewhere: relative imports still point at what they did.
    let from_dir = std::path::Path::new(&path)
        .parent()
        .unwrap_or(std::path::Path::new(""));
    let to_dir = std::path::Path::new(&target)
        .parent()
        .unwrap_or(std::path::Path::new(""));
    if !stdout && from_dir != to_dir {
        let (output, moved) = rebase_imports(&conversion.output, from_dir, to_dir);
        if moved > 0 {
            conversion.output = output;
            conversion.changes.push(format!(
                "adjusted {moved} relative import{} for {}",
                if moved == 1 { "" } else { "s" },
                to_dir.display()
            ));
        }
    }
    for change in &conversion.changes {
        eprintln!("{path}: {change}");
    }
    if stdout {
        print!("{}", conversion.output);
    } else {
        write_atomically(&target, conversion.output.as_bytes())?;
        eprintln!("{path}: wrote {target} (<{}>)", conversion.tag);
    }
    for diagnostic in &conversion.unsupported {
        eprint!("{}", diagnostic.render_warning(&source, &path));
    }
    if let Some(error) = &conversion.compile_error {
        // (In the output, where it is to be fixed.)
        eprint!("{}", error.render_warning(&conversion.output, &target));
    }
    if let Some(error) = &lowering_error {
        eprint!("{}", error.render_warning(&conversion.output, &target));
    }
    let left = conversion.unsupported.len()
        + usize::from(conversion.compile_error.is_some())
        + usize::from(lowering_error.is_some());
    if left == 0 {
        return Ok(());
    }
    Err(format!(
        "{left} thing{} to finish by hand (above)",
        if left == 1 { "" } else { "s" }
    ))
}

/// Rewrite `from './x'` / `import './x'` specifiers written relative to `from` to be relative
/// to `to`. Returns the text and how many changed.
fn rebase_imports(text: &str, from: &std::path::Path, to: &std::path::Path) -> (String, usize) {
    use std::path::{Component, Path, PathBuf};
    let absolute = |path: &Path| -> PathBuf {
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            env::current_dir().unwrap_or_default().join(path)
        };
        let mut out = PathBuf::new();
        for component in path.components() {
            match component {
                Component::ParentDir => {
                    out.pop();
                }
                Component::CurDir => {}
                other => out.push(other.as_os_str()),
            }
        }
        out
    };
    let (from, to) = (absolute(from), absolute(to));
    let relative = |target: &Path| -> String {
        let target: Vec<_> = target.components().collect();
        let base: Vec<_> = to.components().collect();
        let common = target.iter().zip(&base).take_while(|(a, b)| a == b).count();
        let mut parts: Vec<String> = vec!["..".into(); base.len() - common];
        parts.extend(
            target[common..]
                .iter()
                .map(|part| part.as_os_str().to_string_lossy().into_owned()),
        );
        let joined = parts.join("/");
        if joined.starts_with("..") {
            joined
        } else {
            format!("./{joined}")
        }
    };
    let mut out = String::with_capacity(text.len());
    let mut moved = 0;
    let mut rest = text;
    while let Some(at) = rest.find(['\'', '"']) {
        let quote = rest.as_bytes()[at] as char;
        let before = rest[..at].trim_end();
        let is_import =
            before.ends_with(" from") || before.ends_with("import") || before.ends_with("import(");
        let Some(len) = rest[at + 1..].find(quote) else {
            break;
        };
        let specifier = &rest[at + 1..at + 1 + len];
        out.push_str(&rest[..=at]);
        if is_import && (specifier.starts_with("./") || specifier.starts_with("../")) {
            let rebased = relative(&absolute(&from.join(specifier)));
            if rebased != specifier {
                moved += 1;
            }
            out.push_str(&rebased);
        } else {
            out.push_str(specifier);
        }
        out.push(quote);
        rest = &rest[at + 2 + len..];
    }
    out.push_str(rest);
    (out, moved)
}
