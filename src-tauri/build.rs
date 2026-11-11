use std::process::Command;

fn output(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd).args(args).output().ok().and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_default().trim().to_string()
}

fn main() {
    // The splash screen shows the commit and the day it was built.
    println!("cargo:rustc-env=TRELLIS_COMMIT={}", output("git", &["rev-parse", "--short", "HEAD"]));
    println!("cargo:rustc-env=TRELLIS_BUILT={}", output("date", &["+%Y-%m-%d"]));
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs/heads");
    tauri_build::build()
}
