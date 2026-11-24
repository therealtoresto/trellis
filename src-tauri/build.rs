use std::process::Command;

fn output(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd).args(args).output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_default().trim().to_string()
}

fn main() {
    // The build date gives the year in the welcome window's copyright line.
    println!("cargo:rustc-env=TRELLIS_BUILT={}", output("date", &["+%Y-%m-%d"]));
    tauri_build::build()
}
