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
            "usage: mnix compile <component.mnx> --props <props.json> [--output <file>]".into(),
        );
    }
    let source_path = arguments
        .next()
        .ok_or_else(|| "missing component source path".to_owned())?;
    let mut props_path = None;
    let mut output_path = None;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--props" => props_path = arguments.next(),
            "--output" => output_path = arguments.next(),
            _ => return Err(format!("unexpected argument `{argument}`")),
        }
    }
    let props_path = props_path.ok_or_else(|| "missing --props <props.json>".to_owned())?;
    let source = fs::read_to_string(&source_path)
        .map_err(|error| format!("{source_path}: unable to read source: {error}"))?;
    let props = fs::read_to_string(&props_path)
        .map_err(|error| format!("{props_path}: unable to read props: {error}"))?;
    let html = mnix_compiler::compile(&source, &props)
        .map_err(|diagnostic| format!("{source_path}:{diagnostic}"))?;
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
