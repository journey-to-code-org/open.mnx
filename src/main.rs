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
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    if arguments.next().as_deref() != Some("compile") {
        return Err(
            "usage: mnix compile <component.mnx> [--emit html|js|dts|manifest] [--props <props.json>] [--slots <slots.json>] [--runtime <module>] [--keep-imports] [--framework react|vue] [--module-path <path>] [--output <file>]".into(),
        );
    }
    let source_path = arguments
        .next()
        .ok_or_else(|| "missing component source path".to_owned())?;
    let mut props_path = None;
    let mut slots_path = None;
    let mut output_path = None;
    let mut emit = "html".to_owned();
    let mut runtime = "@mnx/runtime".to_owned();
    let mut module_path = None;
    let mut keep_imports = false;
    let mut framework = mnix_compiler::Framework::None;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--emit" => emit = arguments.next().unwrap_or_default(),
            "--runtime" => runtime = arguments.next().unwrap_or_default(),
            "--module-path" => module_path = arguments.next(),
            // For bundler plugins: leave `./x.mnx` imports for the bundler to resolve.
            "--keep-imports" => keep_imports = true,
            // For --emit dts: type the default export as that framework's wrapper.
            "--framework" => {
                framework = match arguments.next().as_deref() {
                    Some("react") => mnix_compiler::Framework::React,
                    Some("vue") => mnix_compiler::Framework::Vue,
                    Some("none") => mnix_compiler::Framework::None,
                    other => {
                        return Err(format!(
                            "unknown --framework `{}`; expected react, vue or none",
                            other.unwrap_or_default()
                        ))
                    }
                }
            }
            "--props" => props_path = arguments.next(),
            "--slots" => slots_path = arguments.next(),
            "--output" => output_path = arguments.next(),
            _ => return Err(format!("unexpected argument `{argument}`")),
        }
    }
    let source = fs::read_to_string(&source_path)
        .map_err(|error| format!("{source_path}: unable to read source: {error}"))?;
    for warning in mnix_compiler::warnings(&source) {
        eprint!("{}", warning.render_warning(&source, &source_path));
    }
    if emit != "html" {
        if props_path.is_some() || slots_path.is_some() {
            return Err(format!(
                "--props and --slots apply to --emit html, not --emit {emit}"
            ));
        }
        let name = Path::new(&source_path)
            .file_name()
            .map_or(source_path.clone(), |name| {
                name.to_string_lossy().into_owned()
            });
        // The JavaScript module the manifest describes: header.mnx → header.js by default.
        let module_path = module_path.unwrap_or_else(|| {
            Path::new(&name)
                .with_extension("js")
                .to_string_lossy()
                .into_owned()
        });
        let output = match emit.as_str() {
            "js" if keep_imports => mnix_compiler::compile_js_with(
                &source,
                &source_path,
                &runtime,
                None,
                &mnix_compiler::filesystem,
            ),
            "js" => mnix_compiler::compile_js_file(&source_path, &runtime),
            "dts" => mnix_compiler::compile_declarations_for(&source, &name, framework),
            "manifest" => mnix_compiler::compile_manifest(&source, &module_path),
            _ => {
                return Err(format!(
                    "unknown --emit `{emit}`; expected html, js, dts or manifest"
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
    let html = if let Some(slots_path) = slots_path {
        let slots = fs::read_to_string(&slots_path)
            .map_err(|error| format!("{slots_path}: unable to read slots: {error}"))?;
        mnix_compiler::compile_file(&source_path, &props, &slots)
    } else {
        mnix_compiler::compile_file(&source_path, &props, "{}")
    }
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
        ".{}.mnix-tmp-{}",
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
